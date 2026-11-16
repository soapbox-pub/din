// din-gpu-priority: a Vulkan layer that keeps web pages' WebGPU work from
// holding up the desktop.
//
// Everything Din draws (its windows, and every page in them) goes through one
// Chromium GPU process. Chromium runs WebGPU on Dawn, which puts all its work
// on the GPU's graphics queue, the one the desktop draws with too. A graphics
// queue runs one job at a time, and on many GPUs (AMD's among them) a running
// job can't be interrupted, so a page's 150 ms compute job held every frame of
// the desktop for 150 ms. Dawn names itself to Vulkan as the engine "Dawn"; on
// its devices (the engines in DIN_VK_LOW_PRIORITY_ENGINES, "Dawn" by default)
// this layer does two things:
//
// - Moves compute to a compute queue. A batch Dawn submits that only
//   computes and copies buffers (no drawing, no images, nothing shared with
//   another process) is replayed onto a queue of the GPU's compute-only
//   family, which runs beside the graphics queue instead of in front of it.
//   Every submit waits on the one before it, through a timeline semaphore, so
//   Dawn's work keeps exactly its order; buffers are made shareable between
//   the two families, so nothing has to change hands. Whatever the layer
//   doesn't know to be safe stays where Dawn put it: every vkCmd* it doesn't
//   handle (generated from the headers, cmds.h) marks its batch as one for
//   the graphics queue.
//
// - Asks for low global priority on Dawn's queues (VK_KHR/EXT_global_priority,
//   which needs no privilege to lower), for GPUs whose kernel drivers can
//   preempt a running job for a higher-priority one.
//
// Where the driver can't do either, the device is made as asked. It's an
// implicit layer, active only where DIN_GPU_PRIORITY=1 is set (Din's
// launcher); DIN_GPU_PRIORITY_COMPUTE=0 keeps the priority and leaves the
// queues alone, and DIN_GPU_PRIORITY_DEBUG=1 says on stderr what it did.

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <pthread.h>
#include <vulkan/vulkan.h>
#include <vulkan/vk_layer.h>

#define EXPORT __attribute__((visibility("default")))

typedef void *DispatchKey;
static inline DispatchKey key_of(const void *handle) { return *(DispatchKey *)handle; }

static bool debug_on(void) {
  static int on = -1;
  if (on < 0) on = getenv("DIN_GPU_PRIORITY_DEBUG") && strcmp(getenv("DIN_GPU_PRIORITY_DEBUG"), "0") != 0;
  return on;
}
#define DEBUG(...) do { if (debug_on()) fprintf(stderr, "din-gpu-priority: " __VA_ARGS__); } while (0)

// ---- Pointer sets ----------------------------------------------------------

#define SET_BUCKETS 1024
struct pnode { const void *key; void *value; struct pnode *next; };
struct pset { struct pnode *b[SET_BUCKETS]; pthread_mutex_t lock; };
#define PSET_INIT { {0}, PTHREAD_MUTEX_INITIALIZER }

static unsigned bucket_of(const void *key) {
  uintptr_t k = (uintptr_t)key;
  k ^= k >> 17; k *= 0xed5ad4bbu; k ^= k >> 11;
  return (unsigned)(k % SET_BUCKETS);
}
// Callers hold the set's lock for get/put/take.
static void *pset_get(struct pset *s, const void *key) {
  for (struct pnode *n = s->b[bucket_of(key)]; n; n = n->next)
    if (n->key == key) return n->value ? n->value : (void *)1;
  return NULL;
}
static void pset_put(struct pset *s, const void *key, void *value) {
  unsigned b = bucket_of(key);
  for (struct pnode *n = s->b[b]; n; n = n->next)
    if (n->key == key) { n->value = value; return; }
  struct pnode *n = malloc(sizeof *n);
  if (!n) return;
  n->key = key; n->value = value; n->next = s->b[b]; s->b[b] = n;
}
static void *pset_take(struct pset *s, const void *key) {
  for (struct pnode **p = &s->b[bucket_of(key)]; *p; p = &(*p)->next) {
    if ((*p)->key == key) {
      struct pnode *n = *p; void *v = n->value; *p = n->next; free(n);
      return v ? v : (void *)1;
    }
  }
  return NULL;
}
static bool pset_has(struct pset *s, const void *key) {
  pthread_mutex_lock(&s->lock);
  bool has = pset_get(s, key) != NULL;
  pthread_mutex_unlock(&s->lock);
  return has;
}
static void pset_add(struct pset *s, const void *key) {
  pthread_mutex_lock(&s->lock); pset_put(s, key, NULL); pthread_mutex_unlock(&s->lock);
}
static void pset_del(struct pset *s, const void *key) {
  pthread_mutex_lock(&s->lock); pset_take(s, key); pthread_mutex_unlock(&s->lock);
}

// Descriptor sets that reference something the compute queue mustn't touch
// (images, texel buffers, buffers shared with another process), and buffers
// shared with another process. Handles are unique across devices.
static struct pset unsafe_sets = PSET_INIT;
static struct pset external_buffers = PSET_INIT;

// ---- Recorded commands -----------------------------------------------------

enum op_type { OP_BIND_PIPELINE, OP_BIND_SETS, OP_PUSH, OP_DISPATCH, OP_DISPATCH_INDIRECT,
               OP_COPY_BUFFER, OP_FILL, OP_UPDATE, OP_BARRIER };

struct op {
  enum op_type type;
  union {
    VkPipeline pipeline;
    struct { VkPipelineLayout layout; uint32_t first, count, dyn_count; VkDescriptorSet *sets; uint32_t *dyn; } sets;
    struct { VkPipelineLayout layout; VkShaderStageFlags stages; uint32_t offset, size; void *data; } push;
    struct { uint32_t bx, by, bz, x, y, z; } dispatch;
    struct { VkBuffer buffer; VkDeviceSize offset; } indirect;
    struct { VkBuffer src, dst; uint32_t count; VkBufferCopy *regions; } copy;
    struct { VkBuffer dst; VkDeviceSize offset, size; uint32_t data; } fill;
    struct { VkBuffer dst; VkDeviceSize offset, size; void *data; } update;
    VkDependencyFlags barrier;
  };
};

static void free_op(struct op *o) {
  switch (o->type) {
  case OP_BIND_SETS: free(o->sets.sets); free(o->sets.dyn); break;
  case OP_PUSH: free(o->push.data); break;
  case OP_COPY_BUFFER: free(o->copy.regions); break;
  case OP_UPDATE: free(o->update.data); break;
  default: break;
  }
}

struct cb_state {
  VkCommandPool pool;
  bool secondary, eligible, has_dispatch;
  struct op *ops;
  uint32_t nops, cap;
};

static void cb_clear(struct cb_state *s) {
  for (uint32_t i = 0; i < s->nops; i++) free_op(&s->ops[i]);
  free(s->ops);
  s->ops = NULL; s->nops = s->cap = 0;
  s->has_dispatch = false;
}

// Command buffers of Dawn's devices: VkCommandBuffer -> struct cb_state.
static struct pset cbs = PSET_INIT;

// ---- Instances and devices -------------------------------------------------

struct instance_data {
  DispatchKey key;
  PFN_vkGetInstanceProcAddr gipa;
  PFN_vkDestroyInstance destroy;
  PFN_vkEnumerateDeviceExtensionProperties enum_ext;
  PFN_vkGetPhysicalDeviceQueueFamilyProperties queue_families;
  PFN_vkGetPhysicalDeviceFeatures2 features2;
  bool low;
};

struct replay { VkCommandBuffer cb; uint64_t value; };

#include "cmds-decl.h"

struct dev {
  DispatchKey key;
  VkDevice device;
  bool wrapped;      // Dawn's: its functions go through this layer
  bool use_compute;  // batches may go to the compute queue
  PFN_vkGetDeviceProcAddr gdpa;
  PFN_vkDestroyDevice destroy;
  PFN_vkSetDeviceLoaderData set_loader_data;

  uint32_t gfx_family, comp_family;
  VkQueue comp_queue;
  VkCommandPool comp_pool;
  VkSemaphore timeline;
  uint64_t timeline_value;
  bool gfx_untracked;
  struct replay *replays;
  uint32_t nreplays;
  uint64_t n_compute, n_graphics;
  pthread_mutex_t lock;

  PFN_vkQueueSubmit QueueSubmit;
  PFN_vkQueueWaitIdle QueueWaitIdle;
  PFN_vkDeviceWaitIdle DeviceWaitIdle;
  PFN_vkGetDeviceQueue GetDeviceQueue;
  PFN_vkCreateBuffer CreateBuffer;
  PFN_vkDestroyBuffer DestroyBuffer;
  PFN_vkUpdateDescriptorSets UpdateDescriptorSets;
  PFN_vkUpdateDescriptorSetWithTemplate UpdateDescriptorSetWithTemplate;
  PFN_vkCreateDescriptorUpdateTemplate CreateDescriptorUpdateTemplate;
  PFN_vkDestroyDescriptorUpdateTemplate DestroyDescriptorUpdateTemplate;
  PFN_vkAllocateCommandBuffers AllocateCommandBuffers;
  PFN_vkFreeCommandBuffers FreeCommandBuffers;
  PFN_vkDestroyCommandPool DestroyCommandPool;
  PFN_vkCreateCommandPool CreateCommandPool;
  PFN_vkBeginCommandBuffer BeginCommandBuffer;
  PFN_vkEndCommandBuffer EndCommandBuffer;
  PFN_vkResetCommandBuffer ResetCommandBuffer;
  PFN_vkResetCommandPool ResetCommandPool;
  PFN_vkCreateSemaphore CreateSemaphore;
  PFN_vkDestroySemaphore DestroySemaphore;
  PFN_vkGetSemaphoreCounterValue GetSemaphoreCounterValue;
  PFN_vkWaitSemaphores WaitSemaphores;
  PFN_vkCmdBindPipeline CmdBindPipeline;
  PFN_vkCmdBindDescriptorSets CmdBindDescriptorSets;
  PFN_vkCmdPushConstants CmdPushConstants;
  PFN_vkCmdDispatch CmdDispatch;
  PFN_vkCmdDispatchIndirect CmdDispatchIndirect;
  PFN_vkCmdDispatchBase CmdDispatchBase;
  PFN_vkCmdCopyBuffer CmdCopyBuffer;
  PFN_vkCmdFillBuffer CmdFillBuffer;
  PFN_vkCmdUpdateBuffer CmdUpdateBuffer;
  PFN_vkCmdPipelineBarrier CmdPipelineBarrier;
  PFN_vkCmdBeginDebugUtilsLabelEXT CmdBeginDebugUtilsLabelEXT;
  PFN_vkCmdEndDebugUtilsLabelEXT CmdEndDebugUtilsLabelEXT;
  PFN_vkCmdInsertDebugUtilsLabelEXT CmdInsertDebugUtilsLabelEXT;
  void *next_cmd[GEN_CMD_COUNT];
};

// Every instance and device made through the layer, by dispatch key.
static struct pset instances = PSET_INIT;
static struct pset devices = PSET_INIT;

static struct instance_data *find_instance(DispatchKey key) {
  pthread_mutex_lock(&instances.lock);
  struct instance_data *i = pset_get(&instances, key);
  pthread_mutex_unlock(&instances.lock);
  return i == (void *)1 ? NULL : i;
}

static struct dev *find_dev(DispatchKey key) {
  pthread_mutex_lock(&devices.lock);
  struct dev *d = pset_get(&devices, key);
  pthread_mutex_unlock(&devices.lock);
  return d == (void *)1 ? NULL : d;
}

static bool engine_is_low(const VkApplicationInfo *app) {
  if (!app || !app->pEngineName) return false;
  const char *list = getenv("DIN_VK_LOW_PRIORITY_ENGINES");
  if (!list || !*list) list = "Dawn";
  size_t want = strlen(app->pEngineName);
  for (const char *p = list; *p;) {
    const char *end = strchr(p, ',');
    size_t len = end ? (size_t)(end - p) : strlen(p);
    if (len == want && strncmp(p, app->pEngineName, len) == 0) return true;
    if (!end) break;
    p = end + 1;
  }
  return false;
}

// ---- Command buffer state --------------------------------------------------

static struct cb_state *cb_get(VkCommandBuffer cb) {
  pthread_mutex_lock(&cbs.lock);
  struct cb_state *s = pset_get(&cbs, cb);
  pthread_mutex_unlock(&cbs.lock);
  return s == (void *)1 ? NULL : s;
}

static bool debug_reasons(void) {
  static int on = -1;
  if (on < 0) on = getenv("DIN_GPU_PRIORITY_DEBUG") && !strcmp(getenv("DIN_GPU_PRIORITY_DEBUG"), "2");
  return on;
}

static struct dev *mark_ineligible(VkCommandBuffer cb, const char *why) {
  struct cb_state *s = cb_get(cb);
  if (s && s->eligible) {
    s->eligible = false; cb_clear(s);
    if (debug_reasons()) fprintf(stderr, "din-gpu-priority: graphics queue: %s\n", why);
  }
  return find_dev(key_of(cb));
}

static struct op *cb_push(struct cb_state *s, enum op_type type) {
  if (!s || !s->eligible) return NULL;
  if (s->nops == s->cap) {
    uint32_t cap = s->cap ? s->cap * 2 : 32;
    struct op *ops = realloc(s->ops, cap * sizeof *ops);
    if (!ops) { s->eligible = false; cb_clear(s); return NULL; }
    s->ops = ops; s->cap = cap;
  }
  struct op *o = &s->ops[s->nops++];
  memset(o, 0, sizeof *o);
  o->type = type;
  return o;
}

static void cb_fail(struct cb_state *s) {
  if (s) { s->nops--; s->eligible = false; cb_clear(s); }
}

#include "cmds.h"

// ---- Handled commands: recorded, and passed on ------------------------------

static VKAPI_ATTR void VKAPI_CALL w_CmdBindPipeline(VkCommandBuffer cb, VkPipelineBindPoint point, VkPipeline p) {
  struct dev *d = find_dev(key_of(cb));
  struct cb_state *s = cb_get(cb);
  if (point != VK_PIPELINE_BIND_POINT_COMPUTE) mark_ineligible(cb, "graphics pipeline");
  else { struct op *o = cb_push(s, OP_BIND_PIPELINE); if (o) o->pipeline = p; }
  d->CmdBindPipeline(cb, point, p);
}

static VKAPI_ATTR void VKAPI_CALL w_CmdBindDescriptorSets(VkCommandBuffer cb, VkPipelineBindPoint point,
                                                          VkPipelineLayout layout, uint32_t first, uint32_t count,
                                                          const VkDescriptorSet *sets, uint32_t dyn_count,
                                                          const uint32_t *dyn) {
  struct dev *d = find_dev(key_of(cb));
  bool ok = point == VK_PIPELINE_BIND_POINT_COMPUTE;
  for (uint32_t i = 0; ok && i < count; i++)
    if (pset_has(&unsafe_sets, sets[i])) ok = false;
  if (!ok) mark_ineligible(cb, "descriptor sets with images or shared buffers");
  else {
    struct cb_state *s = cb_get(cb);
    struct op *o = cb_push(s, OP_BIND_SETS);
    if (o) {
      o->sets.layout = layout; o->sets.first = first; o->sets.count = count; o->sets.dyn_count = dyn_count;
      o->sets.sets = malloc((count ? count : 1) * sizeof *sets);
      o->sets.dyn = malloc((dyn_count ? dyn_count : 1) * sizeof *dyn);
      if (!o->sets.sets || !o->sets.dyn) { free(o->sets.sets); free(o->sets.dyn); cb_fail(s); }
      else {
        if (count) memcpy(o->sets.sets, sets, count * sizeof *sets);
        if (dyn_count) memcpy(o->sets.dyn, dyn, dyn_count * sizeof *dyn);
      }
    }
  }
  d->CmdBindDescriptorSets(cb, point, layout, first, count, sets, dyn_count, dyn);
}

static VKAPI_ATTR void VKAPI_CALL w_CmdPushConstants(VkCommandBuffer cb, VkPipelineLayout layout,
                                                     VkShaderStageFlags stages, uint32_t offset, uint32_t size,
                                                     const void *data) {
  struct dev *d = find_dev(key_of(cb));
  struct cb_state *s = cb_get(cb);
  struct op *o = cb_push(s, OP_PUSH);
  if (o) {
    o->push.layout = layout; o->push.stages = stages; o->push.offset = offset; o->push.size = size;
    o->push.data = malloc(size ? size : 1);
    if (!o->push.data) cb_fail(s); else memcpy(o->push.data, data, size);
  }
  d->CmdPushConstants(cb, layout, stages, offset, size, data);
}

static void record_dispatch(VkCommandBuffer cb, uint32_t bx, uint32_t by, uint32_t bz, uint32_t x, uint32_t y, uint32_t z) {
  struct cb_state *s = cb_get(cb);
  struct op *o = cb_push(s, OP_DISPATCH);
  if (o) {
    o->dispatch.bx = bx; o->dispatch.by = by; o->dispatch.bz = bz;
    o->dispatch.x = x; o->dispatch.y = y; o->dispatch.z = z;
    s->has_dispatch = true;
  }
}

static VKAPI_ATTR void VKAPI_CALL w_CmdDispatch(VkCommandBuffer cb, uint32_t x, uint32_t y, uint32_t z) {
  struct dev *d = find_dev(key_of(cb));
  record_dispatch(cb, 0, 0, 0, x, y, z);
  d->CmdDispatch(cb, x, y, z);
}

static VKAPI_ATTR void VKAPI_CALL w_CmdDispatchBase(VkCommandBuffer cb, uint32_t bx, uint32_t by, uint32_t bz,
                                                    uint32_t x, uint32_t y, uint32_t z) {
  struct dev *d = find_dev(key_of(cb));
  if (!d->CmdDispatchBase) mark_ineligible(cb, "vkCmdDispatchBase"); else record_dispatch(cb, bx, by, bz, x, y, z);
  d->CmdDispatchBase(cb, bx, by, bz, x, y, z);
}

static VKAPI_ATTR void VKAPI_CALL w_CmdDispatchIndirect(VkCommandBuffer cb, VkBuffer buffer, VkDeviceSize offset) {
  struct dev *d = find_dev(key_of(cb));
  if (pset_has(&external_buffers, buffer)) mark_ineligible(cb, "shared indirect buffer");
  else {
    struct cb_state *s = cb_get(cb);
    struct op *o = cb_push(s, OP_DISPATCH_INDIRECT);
    if (o) { o->indirect.buffer = buffer; o->indirect.offset = offset; s->has_dispatch = true; }
  }
  d->CmdDispatchIndirect(cb, buffer, offset);
}

static VKAPI_ATTR void VKAPI_CALL w_CmdCopyBuffer(VkCommandBuffer cb, VkBuffer src, VkBuffer dst, uint32_t count,
                                                  const VkBufferCopy *regions) {
  struct dev *d = find_dev(key_of(cb));
  if (pset_has(&external_buffers, src) || pset_has(&external_buffers, dst)) mark_ineligible(cb, "copy with a shared buffer");
  else {
    struct cb_state *s = cb_get(cb);
    struct op *o = cb_push(s, OP_COPY_BUFFER);
    if (o) {
      o->copy.src = src; o->copy.dst = dst; o->copy.count = count;
      o->copy.regions = malloc((count ? count : 1) * sizeof *regions);
      if (!o->copy.regions) cb_fail(s); else if (count) memcpy(o->copy.regions, regions, count * sizeof *regions);
    }
  }
  d->CmdCopyBuffer(cb, src, dst, count, regions);
}

static VKAPI_ATTR void VKAPI_CALL w_CmdFillBuffer(VkCommandBuffer cb, VkBuffer dst, VkDeviceSize offset,
                                                  VkDeviceSize size, uint32_t data) {
  struct dev *d = find_dev(key_of(cb));
  if (pset_has(&external_buffers, dst)) mark_ineligible(cb, "fill of a shared buffer");
  else {
    struct op *o = cb_push(cb_get(cb), OP_FILL);
    if (o) { o->fill.dst = dst; o->fill.offset = offset; o->fill.size = size; o->fill.data = data; }
  }
  d->CmdFillBuffer(cb, dst, offset, size, data);
}

static VKAPI_ATTR void VKAPI_CALL w_CmdUpdateBuffer(VkCommandBuffer cb, VkBuffer dst, VkDeviceSize offset,
                                                    VkDeviceSize size, const void *data) {
  struct dev *d = find_dev(key_of(cb));
  if (pset_has(&external_buffers, dst)) mark_ineligible(cb, "update of a shared buffer");
  else {
    struct cb_state *s = cb_get(cb);
    struct op *o = cb_push(s, OP_UPDATE);
    if (o) {
      o->update.dst = dst; o->update.offset = offset; o->update.size = size;
      o->update.data = malloc(size ? size : 1);
      if (!o->update.data) cb_fail(s); else memcpy(o->update.data, data, size);
    }
  }
  d->CmdUpdateBuffer(cb, dst, offset, size, data);
}

// A barrier is replayed as one over all memory and all commands, stronger
// than any it stands for; one with images in it, or handing a buffer to
// another queue family or process, keeps its batch on the graphics queue.
static VKAPI_ATTR void VKAPI_CALL w_CmdPipelineBarrier(VkCommandBuffer cb, VkPipelineStageFlags src_stages,
                                                       VkPipelineStageFlags dst_stages, VkDependencyFlags flags,
                                                       uint32_t nmem, const VkMemoryBarrier *mem, uint32_t nbuf,
                                                       const VkBufferMemoryBarrier *bufs, uint32_t nimg,
                                                       const VkImageMemoryBarrier *imgs) {
  struct dev *d = find_dev(key_of(cb));
  bool ok = nimg == 0;
  for (uint32_t i = 0; ok && i < nbuf; i++) {
    if (bufs[i].srcQueueFamilyIndex != bufs[i].dstQueueFamilyIndex) ok = false;
    else if (pset_has(&external_buffers, bufs[i].buffer)) ok = false;
  }
  if (!ok) mark_ineligible(cb, nimg ? "image barrier" : "buffer barrier to another family or a shared buffer");
  else { struct op *o = cb_push(cb_get(cb), OP_BARRIER); if (o) o->barrier = flags; }
  d->CmdPipelineBarrier(cb, src_stages, dst_stages, flags, nmem, mem, nbuf, bufs, nimg, imgs);
}

// Debug labels change nothing the GPU does: passed on, not replayed.
static VKAPI_ATTR void VKAPI_CALL w_CmdBeginDebugUtilsLabelEXT(VkCommandBuffer cb, const VkDebugUtilsLabelEXT *l) {
  find_dev(key_of(cb))->CmdBeginDebugUtilsLabelEXT(cb, l);
}
static VKAPI_ATTR void VKAPI_CALL w_CmdEndDebugUtilsLabelEXT(VkCommandBuffer cb) {
  find_dev(key_of(cb))->CmdEndDebugUtilsLabelEXT(cb);
}
static VKAPI_ATTR void VKAPI_CALL w_CmdInsertDebugUtilsLabelEXT(VkCommandBuffer cb, const VkDebugUtilsLabelEXT *l) {
  find_dev(key_of(cb))->CmdInsertDebugUtilsLabelEXT(cb, l);
}

// ---- Command buffer lifetime ------------------------------------------------

static VKAPI_ATTR VkResult VKAPI_CALL w_AllocateCommandBuffers(VkDevice device, const VkCommandBufferAllocateInfo *info,
                                                               VkCommandBuffer *out) {
  struct dev *d = find_dev(key_of(device));
  VkResult r = d->AllocateCommandBuffers(device, info, out);
  if (r != VK_SUCCESS) return r;
  pthread_mutex_lock(&cbs.lock);
  for (uint32_t i = 0; i < info->commandBufferCount; i++) {
    struct cb_state *s = calloc(1, sizeof *s);
    if (!s) continue;  // no state: mark_ineligible/cb_push see none, and submit treats it as ineligible
    s->pool = info->commandPool;
    s->secondary = info->level != VK_COMMAND_BUFFER_LEVEL_PRIMARY;
    s->eligible = !s->secondary;
    pset_put(&cbs, out[i], s);
  }
  pthread_mutex_unlock(&cbs.lock);
  return r;
}

static void drop_cb(VkCommandBuffer cb) {
  pthread_mutex_lock(&cbs.lock);
  struct cb_state *s = pset_take(&cbs, cb);
  pthread_mutex_unlock(&cbs.lock);
  if (s && s != (void *)1) { cb_clear(s); free(s); }
}

static VKAPI_ATTR void VKAPI_CALL w_FreeCommandBuffers(VkDevice device, VkCommandPool pool, uint32_t n,
                                                       const VkCommandBuffer *list) {
  struct dev *d = find_dev(key_of(device));
  for (uint32_t i = 0; i < n; i++) if (list[i]) drop_cb(list[i]);
  d->FreeCommandBuffers(device, pool, n, list);
}

static VKAPI_ATTR void VKAPI_CALL w_DestroyCommandPool(VkDevice device, VkCommandPool pool, const VkAllocationCallbacks *a) {
  struct dev *d = find_dev(key_of(device));
  if (pool) {
    pthread_mutex_lock(&cbs.lock);
    for (int b = 0; b < SET_BUCKETS; b++) {
      for (struct pnode **p = &cbs.b[b]; *p;) {
        struct cb_state *s = (*p)->value;
        if (s && s->pool == pool) {
          struct pnode *n = *p; *p = n->next; cb_clear(s); free(s); free(n);
        } else p = &(*p)->next;
      }
    }
    pthread_mutex_unlock(&cbs.lock);
  }
  d->DestroyCommandPool(device, pool, a);
}

static void cb_restart(VkCommandBuffer cb) {
  struct cb_state *s = cb_get(cb);
  if (!s) return;
  cb_clear(s);
  s->eligible = !s->secondary;
}

static VKAPI_ATTR VkResult VKAPI_CALL w_BeginCommandBuffer(VkCommandBuffer cb, const VkCommandBufferBeginInfo *info) {
  struct dev *d = find_dev(key_of(cb));
  struct cb_state *s = cb_get(cb);
  if (s) {
    cb_clear(s);
    s->eligible = !s->secondary && !(info->flags & VK_COMMAND_BUFFER_USAGE_SIMULTANEOUS_USE_BIT);
  }
  return d->BeginCommandBuffer(cb, info);
}

static VKAPI_ATTR VkResult VKAPI_CALL w_ResetCommandBuffer(VkCommandBuffer cb, VkCommandBufferResetFlags flags) {
  struct dev *d = find_dev(key_of(cb));
  cb_restart(cb);
  return d->ResetCommandBuffer(cb, flags);
}

// ---- Buffers and descriptors -------------------------------------------------

static bool chain_has(const void *pnext, VkStructureType type) {
  for (const VkBaseInStructure *s = pnext; s; s = s->pNext)
    if (s->sType == type) return true;
  return false;
}

static VKAPI_ATTR VkResult VKAPI_CALL w_CreateBuffer(VkDevice device, const VkBufferCreateInfo *info,
                                                     const VkAllocationCallbacks *a, VkBuffer *out) {
  struct dev *d = find_dev(key_of(device));
  bool external = chain_has(info->pNext, VK_STRUCTURE_TYPE_EXTERNAL_MEMORY_BUFFER_CREATE_INFO);
  VkResult r;
  if (!external && info->sharingMode == VK_SHARING_MODE_EXCLUSIVE && d->comp_queue) {
    uint32_t families[2] = { d->gfx_family, d->comp_family };
    VkBufferCreateInfo shared = *info;
    shared.sharingMode = VK_SHARING_MODE_CONCURRENT;
    shared.queueFamilyIndexCount = 2;
    shared.pQueueFamilyIndices = families;
    r = d->CreateBuffer(device, &shared, a, out);
  } else {
    // Shared with another process, or already shared between families that
    // may not include the compute queue's: kept off it.
    r = d->CreateBuffer(device, info, a, out);
    if (r == VK_SUCCESS) pset_add(&external_buffers, *out);
  }
  return r;
}

static VKAPI_ATTR void VKAPI_CALL w_DestroyBuffer(VkDevice device, VkBuffer buffer, const VkAllocationCallbacks *a) {
  struct dev *d = find_dev(key_of(device));
  if (buffer) pset_del(&external_buffers, buffer);
  d->DestroyBuffer(device, buffer, a);
}

static bool type_is_buffer(VkDescriptorType t) {
  return t == VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER || t == VK_DESCRIPTOR_TYPE_STORAGE_BUFFER ||
         t == VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER_DYNAMIC || t == VK_DESCRIPTOR_TYPE_STORAGE_BUFFER_DYNAMIC;
}

static VKAPI_ATTR void VKAPI_CALL w_UpdateDescriptorSets(VkDevice device, uint32_t nwrites, const VkWriteDescriptorSet *writes,
                                                         uint32_t ncopies, const VkCopyDescriptorSet *copies) {
  struct dev *d = find_dev(key_of(device));
  for (uint32_t i = 0; i < nwrites; i++) {
    const VkWriteDescriptorSet *w = &writes[i];
    bool unsafe = false;
    if (type_is_buffer(w->descriptorType)) {
      for (uint32_t j = 0; j < w->descriptorCount && !unsafe; j++)
        if (w->pBufferInfo && pset_has(&external_buffers, w->pBufferInfo[j].buffer)) unsafe = true;
    } else if (w->descriptorType != VK_DESCRIPTOR_TYPE_SAMPLER) {
      unsafe = true;
    }
    if (unsafe) pset_add(&unsafe_sets, w->dstSet);
  }
  for (uint32_t i = 0; i < ncopies; i++)
    if (pset_has(&unsafe_sets, copies[i].srcSet)) pset_add(&unsafe_sets, copies[i].dstSet);
  d->UpdateDescriptorSets(device, nwrites, writes, ncopies, copies);
}

struct template_info { uint32_t n; VkDescriptorUpdateTemplateEntry *entries; bool unsafe; };
static struct pset templates = PSET_INIT;

static VKAPI_ATTR VkResult VKAPI_CALL w_CreateDescriptorUpdateTemplate(VkDevice device,
                                                                       const VkDescriptorUpdateTemplateCreateInfo *info,
                                                                       const VkAllocationCallbacks *a,
                                                                       VkDescriptorUpdateTemplate *out) {
  struct dev *d = find_dev(key_of(device));
  VkResult r = d->CreateDescriptorUpdateTemplate(device, info, a, out);
  if (r != VK_SUCCESS) return r;
  struct template_info *t = calloc(1, sizeof *t);
  if (t) {
    t->n = info->descriptorUpdateEntryCount;
    t->entries = malloc((t->n ? t->n : 1) * sizeof *t->entries);
    if (t->entries) memcpy(t->entries, info->pDescriptorUpdateEntries, t->n * sizeof *t->entries);
    t->unsafe = !t->entries || info->templateType != VK_DESCRIPTOR_UPDATE_TEMPLATE_TYPE_DESCRIPTOR_SET;
    for (uint32_t i = 0; t->entries && i < t->n; i++) {
      VkDescriptorType ty = t->entries[i].descriptorType;
      if (!type_is_buffer(ty) && ty != VK_DESCRIPTOR_TYPE_SAMPLER) t->unsafe = true;
    }
    pthread_mutex_lock(&templates.lock);
    pset_put(&templates, *out, t);
    pthread_mutex_unlock(&templates.lock);
  }
  return r;
}

static VKAPI_ATTR void VKAPI_CALL w_DestroyDescriptorUpdateTemplate(VkDevice device, VkDescriptorUpdateTemplate tpl,
                                                                    const VkAllocationCallbacks *a) {
  struct dev *d = find_dev(key_of(device));
  if (tpl) {
    pthread_mutex_lock(&templates.lock);
    struct template_info *t = pset_take(&templates, tpl);
    pthread_mutex_unlock(&templates.lock);
    if (t && t != (void *)1) { free(t->entries); free(t); }
  }
  d->DestroyDescriptorUpdateTemplate(device, tpl, a);
}

static VKAPI_ATTR void VKAPI_CALL w_UpdateDescriptorSetWithTemplate(VkDevice device, VkDescriptorSet set,
                                                                    VkDescriptorUpdateTemplate tpl, const void *data) {
  struct dev *d = find_dev(key_of(device));
  pthread_mutex_lock(&templates.lock);
  struct template_info *t = pset_get(&templates, tpl);
  bool unsafe = !t || t == (void *)1 || t->unsafe;
  for (uint32_t i = 0; !unsafe && i < t->n; i++) {
    const VkDescriptorUpdateTemplateEntry *e = &t->entries[i];
    if (!type_is_buffer(e->descriptorType)) continue;
    for (uint32_t j = 0; j < e->descriptorCount && !unsafe; j++) {
      const VkDescriptorBufferInfo *b = (const void *)((const char *)data + e->offset + j * e->stride);
      if (pset_has(&external_buffers, b->buffer)) unsafe = true;
    }
  }
  pthread_mutex_unlock(&templates.lock);
  if (unsafe) pset_add(&unsafe_sets, set);
  d->UpdateDescriptorSetWithTemplate(device, set, tpl, data);
}

// ---- Submitting ----------------------------------------------------------------

static void record_replay(struct dev *d, VkCommandBuffer out, struct cb_state *s) {
  for (uint32_t i = 0; i < s->nops; i++) {
    struct op *o = &s->ops[i];
    switch (o->type) {
    case OP_BIND_PIPELINE: d->CmdBindPipeline(out, VK_PIPELINE_BIND_POINT_COMPUTE, o->pipeline); break;
    case OP_BIND_SETS:
      d->CmdBindDescriptorSets(out, VK_PIPELINE_BIND_POINT_COMPUTE, o->sets.layout, o->sets.first, o->sets.count,
                               o->sets.sets, o->sets.dyn_count, o->sets.dyn);
      break;
    case OP_PUSH: d->CmdPushConstants(out, o->push.layout, o->push.stages, o->push.offset, o->push.size, o->push.data); break;
    case OP_DISPATCH:
      if (o->dispatch.bx || o->dispatch.by || o->dispatch.bz)
        d->CmdDispatchBase(out, o->dispatch.bx, o->dispatch.by, o->dispatch.bz, o->dispatch.x, o->dispatch.y, o->dispatch.z);
      else
        d->CmdDispatch(out, o->dispatch.x, o->dispatch.y, o->dispatch.z);
      break;
    case OP_DISPATCH_INDIRECT: d->CmdDispatchIndirect(out, o->indirect.buffer, o->indirect.offset); break;
    case OP_COPY_BUFFER: d->CmdCopyBuffer(out, o->copy.src, o->copy.dst, o->copy.count, o->copy.regions); break;
    case OP_FILL: d->CmdFillBuffer(out, o->fill.dst, o->fill.offset, o->fill.size, o->fill.data); break;
    case OP_UPDATE: d->CmdUpdateBuffer(out, o->update.dst, o->update.offset, o->update.size, o->update.data); break;
    case OP_BARRIER: {
      VkMemoryBarrier all = { VK_STRUCTURE_TYPE_MEMORY_BARRIER, NULL,
                              VK_ACCESS_MEMORY_READ_BIT | VK_ACCESS_MEMORY_WRITE_BIT,
                              VK_ACCESS_MEMORY_READ_BIT | VK_ACCESS_MEMORY_WRITE_BIT };
      d->CmdPipelineBarrier(out, VK_PIPELINE_STAGE_ALL_COMMANDS_BIT, VK_PIPELINE_STAGE_ALL_COMMANDS_BIT, o->barrier,
                            1, &all, 0, NULL, 0, NULL);
      break;
    }
    }
  }
}

// A compute-family command buffer holding the batch, or NULL. Called with d->lock held.
static VkCommandBuffer make_replay(struct dev *d, const VkSubmitInfo *si, uint32_t *slot) {
  uint64_t done = 0;
  if (d->GetSemaphoreCounterValue(d->device, d->timeline, &done) != VK_SUCCESS) return VK_NULL_HANDLE;
  uint32_t k = d->nreplays;
  for (uint32_t i = 0; i < d->nreplays; i++)
    if (d->replays[i].value <= done) { k = i; break; }
  if (k == d->nreplays) {
    if (d->nreplays >= 256) return VK_NULL_HANDLE;
    struct replay *grown = realloc(d->replays, (d->nreplays + 1) * sizeof *grown);
    if (!grown) return VK_NULL_HANDLE;
    d->replays = grown;
    VkCommandBufferAllocateInfo ai = { VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO, NULL, d->comp_pool,
                                       VK_COMMAND_BUFFER_LEVEL_PRIMARY, 1 };
    VkCommandBuffer cb;
    if (d->AllocateCommandBuffers(d->device, &ai, &cb) != VK_SUCCESS) return VK_NULL_HANDLE;
    if (d->set_loader_data) d->set_loader_data(d->device, cb);
    d->replays[k].cb = cb;
    d->replays[k].value = 0;
    d->nreplays++;
  } else {
    d->ResetCommandBuffer(d->replays[k].cb, 0);
  }
  VkCommandBuffer cb = d->replays[k].cb;
  // In use until this batch's value is set at submit; nothing else can take it meanwhile.
  d->replays[k].value = UINT64_MAX;
  VkCommandBufferBeginInfo bi = { VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO, NULL,
                                  VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT, NULL };
  if (d->BeginCommandBuffer(cb, &bi) != VK_SUCCESS) { d->replays[k].value = 0; return VK_NULL_HANDLE; }
  for (uint32_t i = 0; i < si->commandBufferCount; i++) {
    struct cb_state *s = cb_get(si->pCommandBuffers[i]);
    record_replay(d, cb, s);
  }
  if (d->EndCommandBuffer(cb) != VK_SUCCESS) { d->replays[k].value = 0; return VK_NULL_HANDLE; }
  *slot = k;
  return cb;
}

static bool batch_eligible(const VkSubmitInfo *si) {
  if (si->pNext || si->commandBufferCount == 0) return false;
  bool dispatch = false;
  for (uint32_t i = 0; i < si->commandBufferCount; i++) {
    struct cb_state *s = cb_get(si->pCommandBuffers[i]);
    if (!s || !s->eligible) return false;
    dispatch = dispatch || s->has_dispatch;
  }
  return dispatch;
}

// Waits on the CPU until everything this layer has submitted for the device is done.
static void drain(struct dev *d) {
  if (!d->timeline_value) return;
  VkSemaphoreWaitInfo wi = { VK_STRUCTURE_TYPE_SEMAPHORE_WAIT_INFO, NULL, 0, 1, &d->timeline, &d->timeline_value };
  d->WaitSemaphores(d->device, &wi, UINT64_MAX);
}

struct built {
  VkSubmitInfo info;
  VkTimelineSemaphoreSubmitInfo tl;
  VkSemaphore *waits, *signals;
  VkPipelineStageFlags *stages;
  uint64_t *wait_values, *signal_values;
  VkCommandBuffer replay;
  uint32_t slot;
  bool compute;
};

static void free_built(struct built *b) {
  free(b->waits); free(b->signals); free(b->stages); free(b->wait_values); free(b->signal_values);
}

static VKAPI_ATTR VkResult VKAPI_CALL w_QueueSubmit(VkQueue queue, uint32_t n, const VkSubmitInfo *infos, VkFence fence) {
  struct dev *d = find_dev(key_of(queue));
  pthread_mutex_lock(&d->lock);
  bool plain = !d->timeline;
  for (uint32_t i = 0; i < n && !plain; i++) if (infos[i].pNext) plain = true;
  if (plain) {
    // Something this layer doesn't take apart: wait for what it has in flight,
    // and send this on as it came.
    drain(d);
    VkResult r = d->QueueSubmit(queue, n, infos, fence);
    if (d->timeline) d->gfx_untracked = true;
    pthread_mutex_unlock(&d->lock);
    return r;
  }

  VkSubmitInfo empty = { .sType = VK_STRUCTURE_TYPE_SUBMIT_INFO };
  if (n == 0) { infos = &empty; n = 1; }
  struct built *b = calloc(n, sizeof *b);
  if (!b) { pthread_mutex_unlock(&d->lock); return VK_ERROR_OUT_OF_HOST_MEMORY; }

  VkResult result = VK_SUCCESS;
  uint64_t value = d->timeline_value;
  for (uint32_t i = 0; i < n; i++) {
    const VkSubmitInfo *si = &infos[i];
    struct built *x = &b[i];
    x->compute = d->use_compute && batch_eligible(si);
    if (x->compute) {
      x->replay = make_replay(d, si, &x->slot);
      if (!x->replay) x->compute = false;
    }
    uint32_t nw = si->waitSemaphoreCount + (value ? 1 : 0);
    uint32_t ns = si->signalSemaphoreCount + 1;
    x->waits = malloc((nw ? nw : 1) * sizeof *x->waits);
    x->stages = malloc((nw ? nw : 1) * sizeof *x->stages);
    x->wait_values = calloc(nw ? nw : 1, sizeof *x->wait_values);
    x->signals = malloc(ns * sizeof *x->signals);
    x->signal_values = calloc(ns, sizeof *x->signal_values);
    if (!x->waits || !x->stages || !x->wait_values || !x->signals || !x->signal_values) {
      result = VK_ERROR_OUT_OF_HOST_MEMORY;
      break;
    }
    for (uint32_t j = 0; j < si->waitSemaphoreCount; j++) {
      x->waits[j] = si->pWaitSemaphores[j];
      x->stages[j] = x->compute ? VK_PIPELINE_STAGE_ALL_COMMANDS_BIT : si->pWaitDstStageMask[j];
    }
    if (value) {
      x->waits[nw - 1] = d->timeline;
      x->stages[nw - 1] = VK_PIPELINE_STAGE_ALL_COMMANDS_BIT;
      x->wait_values[nw - 1] = value;
    }
    for (uint32_t j = 0; j < si->signalSemaphoreCount; j++) x->signals[j] = si->pSignalSemaphores[j];
    x->signals[ns - 1] = d->timeline;
    x->signal_values[ns - 1] = ++value;

    x->tl = (VkTimelineSemaphoreSubmitInfo){ VK_STRUCTURE_TYPE_TIMELINE_SEMAPHORE_SUBMIT_INFO, NULL,
                                              nw, x->wait_values, ns, x->signal_values };
    x->info = *si;
    x->info.pNext = &x->tl;
    x->info.waitSemaphoreCount = nw;
    x->info.pWaitSemaphores = x->waits;
    x->info.pWaitDstStageMask = x->stages;
    x->info.signalSemaphoreCount = ns;
    x->info.pSignalSemaphores = x->signals;
    if (x->compute) { x->info.commandBufferCount = 1; x->info.pCommandBuffers = &x->replay; }
  }

  if (result == VK_SUCCESS && d->gfx_untracked) {
    bool any_compute = false;
    for (uint32_t i = 0; i < n; i++) any_compute = any_compute || b[i].compute;
    if (any_compute) { d->QueueWaitIdle(queue); d->gfx_untracked = false; }
  }

  // Runs of batches for the same queue go in one call; the fence on the last.
  for (uint32_t i = 0; result == VK_SUCCESS && i < n;) {
    uint32_t j = i;
    VkSubmitInfo *run = malloc(n * sizeof *run);
    if (!run) { result = VK_ERROR_OUT_OF_HOST_MEMORY; break; }
    while (j < n && b[j].compute == b[i].compute) { run[j - i] = b[j].info; j++; }
    result = d->QueueSubmit(b[i].compute ? d->comp_queue : queue, j - i, run, j == n ? fence : VK_NULL_HANDLE);
    free(run);
    if (result == VK_SUCCESS) {
      for (uint32_t k = i; k < j; k++) {
        if (debug_reasons() && d->n_compute + d->n_graphics < 200)
          fprintf(stderr, "din-gpu-priority: batch %llu -> %s (%u command buffers, waits %u, signals %u)\n",
                  (unsigned long long)(d->n_compute + d->n_graphics), b[k].compute ? "compute" : "graphics",
                  infos[k].commandBufferCount, infos[k].waitSemaphoreCount, infos[k].signalSemaphoreCount);
        if (b[k].compute) { d->replays[b[k].slot].value = b[k].signal_values[b[k].info.signalSemaphoreCount - 1]; d->n_compute++; }
        else d->n_graphics++;
      }
      d->timeline_value = b[j - 1].signal_values[b[j - 1].info.signalSemaphoreCount - 1];
    }
    i = j;
  }
  for (uint32_t i = 0; i < n; i++) {
    if (b[i].compute && d->replays[b[i].slot].value == UINT64_MAX) d->replays[b[i].slot].value = 0;
    free_built(&b[i]);
  }
  free(b);
  if (debug_on() && (d->n_compute + d->n_graphics) % 500 == 0 && d->n_compute + d->n_graphics)
    DEBUG("%llu batches on the compute queue, %llu on the graphics queue\n",
          (unsigned long long)d->n_compute, (unsigned long long)d->n_graphics);
  pthread_mutex_unlock(&d->lock);
  return result;
}

static VKAPI_ATTR VkResult VKAPI_CALL w_QueueWaitIdle(VkQueue queue) {
  struct dev *d = find_dev(key_of(queue));
  pthread_mutex_lock(&d->lock);
  VkResult r = d->QueueWaitIdle(queue);
  if (r == VK_SUCCESS && d->comp_queue) r = d->QueueWaitIdle(d->comp_queue);
  pthread_mutex_unlock(&d->lock);
  return r;
}

// ---- Instance ---------------------------------------------------------------------

static VkLayerInstanceCreateInfo *instance_link(const VkInstanceCreateInfo *info) {
  for (const VkBaseInStructure *s = info->pNext; s; s = s->pNext) {
    if (s->sType == VK_STRUCTURE_TYPE_LOADER_INSTANCE_CREATE_INFO &&
        ((const VkLayerInstanceCreateInfo *)s)->function == VK_LAYER_LINK_INFO)
      return (VkLayerInstanceCreateInfo *)s;
  }
  return NULL;
}

static const VkLayerDeviceCreateInfo *device_chain(const VkDeviceCreateInfo *info, VkLayerFunction fn) {
  for (const VkBaseInStructure *s = info->pNext; s; s = s->pNext) {
    if (s->sType == VK_STRUCTURE_TYPE_LOADER_DEVICE_CREATE_INFO &&
        ((const VkLayerDeviceCreateInfo *)s)->function == fn)
      return (const VkLayerDeviceCreateInfo *)s;
  }
  return NULL;
}

static VKAPI_ATTR VkResult VKAPI_CALL layer_CreateInstance(const VkInstanceCreateInfo *info,
                                                           const VkAllocationCallbacks *alloc, VkInstance *out) {
  VkLayerInstanceCreateInfo *link = instance_link(info);
  if (!link) return VK_ERROR_INITIALIZATION_FAILED;
  PFN_vkGetInstanceProcAddr gipa = link->u.pLayerInfo->pfnNextGetInstanceProcAddr;
  link->u.pLayerInfo = link->u.pLayerInfo->pNext;
  PFN_vkCreateInstance create = (PFN_vkCreateInstance)gipa(VK_NULL_HANDLE, "vkCreateInstance");
  if (!create) return VK_ERROR_INITIALIZATION_FAILED;
  VkResult result = create(info, alloc, out);
  if (result != VK_SUCCESS) return result;

  struct instance_data *data = calloc(1, sizeof *data);
  if (data) {
    data->key = key_of(*out);
    data->gipa = gipa;
    data->destroy = (PFN_vkDestroyInstance)gipa(*out, "vkDestroyInstance");
    data->enum_ext = (PFN_vkEnumerateDeviceExtensionProperties)gipa(*out, "vkEnumerateDeviceExtensionProperties");
    data->queue_families = (PFN_vkGetPhysicalDeviceQueueFamilyProperties)gipa(*out, "vkGetPhysicalDeviceQueueFamilyProperties");
    data->features2 = (PFN_vkGetPhysicalDeviceFeatures2)gipa(*out, "vkGetPhysicalDeviceFeatures2");
    if (!data->features2) data->features2 = (PFN_vkGetPhysicalDeviceFeatures2)gipa(*out, "vkGetPhysicalDeviceFeatures2KHR");
    data->low = engine_is_low(info->pApplicationInfo);
    pthread_mutex_lock(&instances.lock);
    pset_put(&instances, data->key, data);
    pthread_mutex_unlock(&instances.lock);
  }
  if (!data) {
    PFN_vkDestroyInstance destroy = (PFN_vkDestroyInstance)gipa(*out, "vkDestroyInstance");
    if (destroy) destroy(*out, alloc);
    *out = VK_NULL_HANDLE;
    return VK_ERROR_INITIALIZATION_FAILED;
  }
  return VK_SUCCESS;
}

static VKAPI_ATTR void VKAPI_CALL layer_DestroyInstance(VkInstance instance, const VkAllocationCallbacks *alloc) {
  if (!instance) return;
  pthread_mutex_lock(&instances.lock);
  struct instance_data *data = pset_take(&instances, key_of(instance));
  pthread_mutex_unlock(&instances.lock);
  if (data == (void *)1) data = NULL;
  PFN_vkDestroyInstance destroy = data ? data->destroy : NULL;
  free(data);
  if (destroy) destroy(instance, alloc);
}

// ---- Device -------------------------------------------------------------------------

static bool has_ext(struct instance_data *inst, VkPhysicalDevice pd, const char *name) {
  if (!inst->enum_ext) return false;
  uint32_t count = 0;
  if (inst->enum_ext(pd, NULL, &count, NULL) != VK_SUCCESS || count == 0) return false;
  VkExtensionProperties *props = calloc(count, sizeof *props);
  if (!props) return false;
  bool found = false;
  if (inst->enum_ext(pd, NULL, &count, props) == VK_SUCCESS)
    for (uint32_t i = 0; i < count && !found; i++) found = !strcmp(props[i].extensionName, name);
  free(props);
  return found;
}

static bool ext_listed(const VkDeviceCreateInfo *info, const char *name) {
  for (uint32_t i = 0; i < info->enabledExtensionCount; i++)
    if (!strcmp(info->ppEnabledExtensionNames[i], name)) return true;
  return false;
}

static bool compute_wanted(void) {
  const char *v = getenv("DIN_GPU_PRIORITY_COMPUTE");
  return !v || strcmp(v, "0") != 0;
}

struct plan {
  bool priority, compute;
  const char *prio_ext;
  uint32_t gfx_family, comp_family;
};

static VkResult create_with(PFN_vkCreateDevice create, VkPhysicalDevice pd, const VkDeviceCreateInfo *info,
                            const VkAllocationCallbacks *alloc, VkDevice *out, const struct plan *p) {
  uint32_t nq = info->queueCreateInfoCount;
  VkDeviceQueueCreateInfo *queues = calloc(nq + 1, sizeof *queues);
  VkDeviceQueueGlobalPriorityCreateInfoKHR *prios = calloc(nq + 1, sizeof *prios);
  const char **exts = calloc(info->enabledExtensionCount + 2, sizeof *exts);
  VkResult r = VK_ERROR_OUT_OF_HOST_MEMORY;
  static const float one = 1.0f;
  if (queues && prios && exts) {
    memcpy(queues, info->pQueueCreateInfos, nq * sizeof *queues);
    if (p->compute) {
      queues[nq] = (VkDeviceQueueCreateInfo){ VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO, NULL, 0, p->comp_family, 1, &one };
      nq++;
    }
    for (uint32_t i = 0; p->priority && i < nq; i++) {
      if (chain_has(queues[i].pNext, VK_STRUCTURE_TYPE_DEVICE_QUEUE_GLOBAL_PRIORITY_CREATE_INFO_KHR)) continue;
      prios[i] = (VkDeviceQueueGlobalPriorityCreateInfoKHR){ VK_STRUCTURE_TYPE_DEVICE_QUEUE_GLOBAL_PRIORITY_CREATE_INFO_KHR,
                                                             queues[i].pNext, VK_QUEUE_GLOBAL_PRIORITY_LOW_KHR };
      queues[i].pNext = &prios[i];
    }
    uint32_t ne = 0;
    for (uint32_t i = 0; i < info->enabledExtensionCount; i++) exts[ne++] = info->ppEnabledExtensionNames[i];
    if (p->priority && !ext_listed(info, VK_KHR_GLOBAL_PRIORITY_EXTENSION_NAME) &&
        !ext_listed(info, VK_EXT_GLOBAL_PRIORITY_EXTENSION_NAME))
      exts[ne++] = p->prio_ext;
    if (p->compute && !ext_listed(info, VK_KHR_TIMELINE_SEMAPHORE_EXTENSION_NAME))
      exts[ne++] = VK_KHR_TIMELINE_SEMAPHORE_EXTENSION_NAME;

    VkDeviceCreateInfo mod = *info;
    mod.queueCreateInfoCount = nq;
    mod.pQueueCreateInfos = queues;
    mod.enabledExtensionCount = ne;
    mod.ppEnabledExtensionNames = exts;
    // Timeline semaphores: turned on in whatever feature struct Dawn passes,
    // or in one of the layer's own.
    VkPhysicalDeviceTimelineSemaphoreFeatures tl = { VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_TIMELINE_SEMAPHORE_FEATURES,
                                                      (void *)info->pNext, VK_TRUE };
    VkBool32 *flag = NULL, old = VK_FALSE;
    if (p->compute) {
      for (const VkBaseInStructure *s = info->pNext; s && !flag; s = s->pNext) {
        if (s->sType == VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_2_FEATURES)
          flag = &((VkPhysicalDeviceVulkan12Features *)s)->timelineSemaphore;
        else if (s->sType == VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_TIMELINE_SEMAPHORE_FEATURES)
          flag = &((VkPhysicalDeviceTimelineSemaphoreFeatures *)s)->timelineSemaphore;
      }
      if (flag) { old = *flag; *flag = VK_TRUE; } else mod.pNext = &tl;
    }
    r = create(pd, &mod, alloc, out);
    if (flag) *flag = old;
  }
  free(queues); free(prios); free(exts);
  return r;
}

#define LOAD(d, name) (d)->name = (PFN_vk##name)(d)->gdpa((d)->device, "vk" #name)

static bool setup_compute(struct dev *d) {
  LOAD(d, QueueSubmit); LOAD(d, QueueWaitIdle); LOAD(d, DeviceWaitIdle); LOAD(d, GetDeviceQueue);
  LOAD(d, CreateBuffer); LOAD(d, DestroyBuffer); LOAD(d, UpdateDescriptorSets);
  LOAD(d, UpdateDescriptorSetWithTemplate); LOAD(d, CreateDescriptorUpdateTemplate); LOAD(d, DestroyDescriptorUpdateTemplate);
  LOAD(d, AllocateCommandBuffers); LOAD(d, FreeCommandBuffers); LOAD(d, DestroyCommandPool); LOAD(d, CreateCommandPool);
  LOAD(d, BeginCommandBuffer); LOAD(d, EndCommandBuffer); LOAD(d, ResetCommandBuffer); LOAD(d, ResetCommandPool);
  LOAD(d, CreateSemaphore); LOAD(d, DestroySemaphore);
  LOAD(d, CmdBindPipeline); LOAD(d, CmdBindDescriptorSets); LOAD(d, CmdPushConstants); LOAD(d, CmdDispatch);
  LOAD(d, CmdDispatchIndirect); LOAD(d, CmdCopyBuffer); LOAD(d, CmdFillBuffer); LOAD(d, CmdUpdateBuffer);
  LOAD(d, CmdPipelineBarrier); LOAD(d, CmdBeginDebugUtilsLabelEXT); LOAD(d, CmdEndDebugUtilsLabelEXT);
  LOAD(d, CmdInsertDebugUtilsLabelEXT);
  d->CmdDispatchBase = (PFN_vkCmdDispatchBase)d->gdpa(d->device, "vkCmdDispatchBase");
  if (!d->CmdDispatchBase) d->CmdDispatchBase = (PFN_vkCmdDispatchBase)d->gdpa(d->device, "vkCmdDispatchBaseKHR");
  d->GetSemaphoreCounterValue = (PFN_vkGetSemaphoreCounterValue)d->gdpa(d->device, "vkGetSemaphoreCounterValueKHR");
  d->WaitSemaphores = (PFN_vkWaitSemaphores)d->gdpa(d->device, "vkWaitSemaphoresKHR");
  if (!d->QueueSubmit || !d->QueueWaitIdle || !d->GetDeviceQueue || !d->CreateCommandPool || !d->AllocateCommandBuffers ||
      !d->CreateSemaphore || !d->GetSemaphoreCounterValue || !d->WaitSemaphores || !d->BeginCommandBuffer ||
      !d->EndCommandBuffer || !d->ResetCommandBuffer)
    return false;

  d->GetDeviceQueue(d->device, d->comp_family, 0, &d->comp_queue);
  if (!d->comp_queue) return false;
  if (d->set_loader_data) d->set_loader_data(d->device, d->comp_queue);
  VkCommandPoolCreateInfo pci = { VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO, NULL,
                                  VK_COMMAND_POOL_CREATE_RESET_COMMAND_BUFFER_BIT, d->comp_family };
  if (d->CreateCommandPool(d->device, &pci, NULL, &d->comp_pool) != VK_SUCCESS) { d->comp_queue = VK_NULL_HANDLE; return false; }
  VkSemaphoreTypeCreateInfo type = { VK_STRUCTURE_TYPE_SEMAPHORE_TYPE_CREATE_INFO, NULL, VK_SEMAPHORE_TYPE_TIMELINE, 0 };
  VkSemaphoreCreateInfo sci = { VK_STRUCTURE_TYPE_SEMAPHORE_CREATE_INFO, &type, 0 };
  if (d->CreateSemaphore(d->device, &sci, NULL, &d->timeline) != VK_SUCCESS) {
    d->DestroyCommandPool(d->device, d->comp_pool, NULL);
    d->comp_pool = VK_NULL_HANDLE; d->comp_queue = VK_NULL_HANDLE;
    return false;
  }
  return true;
}

static VKAPI_ATTR VkResult VKAPI_CALL layer_CreateDevice(VkPhysicalDevice pd, const VkDeviceCreateInfo *info,
                                                         const VkAllocationCallbacks *alloc, VkDevice *out) {
  VkLayerDeviceCreateInfo *link = (VkLayerDeviceCreateInfo *)device_chain(info, VK_LAYER_LINK_INFO);
  if (!link) return VK_ERROR_INITIALIZATION_FAILED;
  PFN_vkGetInstanceProcAddr gipa = link->u.pLayerInfo->pfnNextGetInstanceProcAddr;
  PFN_vkGetDeviceProcAddr gdpa = link->u.pLayerInfo->pfnNextGetDeviceProcAddr;
  link->u.pLayerInfo = link->u.pLayerInfo->pNext;
  const VkLayerDeviceCreateInfo *loader_cb = device_chain(info, VK_LOADER_DATA_CALLBACK);
  PFN_vkCreateDevice create = (PFN_vkCreateDevice)gipa(VK_NULL_HANDLE, "vkCreateDevice");
  if (!create) return VK_ERROR_INITIALIZATION_FAILED;

  pthread_mutex_lock(&instances.lock);
  struct instance_data *found = pset_get(&instances, key_of(pd));
  struct instance_data inst = found && found != (void *)1 ? *found : (struct instance_data){0};
  pthread_mutex_unlock(&instances.lock);

  struct plan p = {0};
  if (inst.low) {
    if (has_ext(&inst, pd, VK_KHR_GLOBAL_PRIORITY_EXTENSION_NAME)) p.prio_ext = VK_KHR_GLOBAL_PRIORITY_EXTENSION_NAME;
    else if (has_ext(&inst, pd, VK_EXT_GLOBAL_PRIORITY_EXTENSION_NAME)) p.prio_ext = VK_EXT_GLOBAL_PRIORITY_EXTENSION_NAME;
    p.priority = p.prio_ext != NULL;

    // The compute queue: Dawn's one queue family, a graphics one, and a
    // compute-only family beside it, with timeline semaphores to order them.
    VkQueueFamilyProperties fam[32];
    uint32_t nf = 32;
    if (inst.queue_families) inst.queue_families(pd, &nf, fam); else nf = 0;
    bool one_family = info->queueCreateInfoCount >= 1;
    for (uint32_t i = 1; one_family && i < info->queueCreateInfoCount; i++)
      if (info->pQueueCreateInfos[i].queueFamilyIndex != info->pQueueCreateInfos[0].queueFamilyIndex) one_family = false;
    if (compute_wanted() && one_family && inst.features2 &&
        info->pQueueCreateInfos[0].queueFamilyIndex < nf &&
        (fam[info->pQueueCreateInfos[0].queueFamilyIndex].queueFlags & VK_QUEUE_GRAPHICS_BIT) &&
        has_ext(&inst, pd, VK_KHR_TIMELINE_SEMAPHORE_EXTENSION_NAME)) {
      VkPhysicalDeviceTimelineSemaphoreFeatures tl = { .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_TIMELINE_SEMAPHORE_FEATURES };
      VkPhysicalDeviceFeatures2 f2 = { .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FEATURES_2, .pNext = &tl };
      inst.features2(pd, &f2);
      for (uint32_t i = 0; tl.timelineSemaphore && i < nf; i++) {
        if ((fam[i].queueFlags & VK_QUEUE_COMPUTE_BIT) && !(fam[i].queueFlags & VK_QUEUE_GRAPHICS_BIT) &&
            fam[i].queueCount > 0) {
          p.compute = true;
          p.comp_family = i;
          p.gfx_family = info->pQueueCreateInfos[0].queueFamilyIndex;
          break;
        }
      }
    }
  }

  // Everything that was wanted, then without the priority, then as asked.
  VkResult result = VK_ERROR_INITIALIZATION_FAILED;
  struct plan tried = p;
  if (p.priority || p.compute) result = create_with(create, pd, info, alloc, out, &tried);
  if (result != VK_SUCCESS && p.priority && p.compute) {
    tried.priority = false;
    result = create_with(create, pd, info, alloc, out, &tried);
  }
  if (result != VK_SUCCESS) {
    tried = (struct plan){0};
    result = create(pd, info, alloc, out);
  }
  if (result != VK_SUCCESS) return result;
  if (inst.low)
    DEBUG("Dawn device: %s priority, %s\n", tried.priority ? "low" : "normal",
          tried.compute ? "compute on its own queue" : "compute on the graphics queue");

  struct dev *d = calloc(1, sizeof *d);
  if (d) {
    d->key = key_of(*out);
    d->device = *out;
    d->gdpa = gdpa;
    d->destroy = (PFN_vkDestroyDevice)gdpa(*out, "vkDestroyDevice");
    d->set_loader_data = loader_cb ? loader_cb->u.pfnSetDeviceLoaderData : NULL;
    pthread_mutex_init(&d->lock, NULL);
    if (tried.compute) {
      d->gfx_family = tried.gfx_family;
      d->comp_family = tried.comp_family;
      d->wrapped = setup_compute(d);
      d->use_compute = d->wrapped;
      if (!d->wrapped) DEBUG("couldn't set up the compute queue; leaving Dawn's work where it is\n");
    }
    pthread_mutex_lock(&devices.lock);
    pset_put(&devices, d->key, d);
    pthread_mutex_unlock(&devices.lock);
  }
  if (!d) {
    PFN_vkDestroyDevice destroy = (PFN_vkDestroyDevice)gdpa(*out, "vkDestroyDevice");
    if (destroy) destroy(*out, alloc);
    *out = VK_NULL_HANDLE;
    return VK_ERROR_INITIALIZATION_FAILED;
  }
  return VK_SUCCESS;
}

static VKAPI_ATTR void VKAPI_CALL layer_DestroyDevice(VkDevice device, const VkAllocationCallbacks *alloc) {
  if (!device) return;
  pthread_mutex_lock(&devices.lock);
  struct dev *d = pset_take(&devices, key_of(device));
  pthread_mutex_unlock(&devices.lock);
  if (!d || d == (void *)1) return;
  if (d->wrapped) {
    if (d->DeviceWaitIdle) d->DeviceWaitIdle(device);
    if (d->comp_pool) d->DestroyCommandPool(device, d->comp_pool, NULL);
    if (d->timeline) d->DestroySemaphore(device, d->timeline, NULL);
    free(d->replays);
  }
  PFN_vkDestroyDevice destroy = d->destroy;
  pthread_mutex_destroy(&d->lock);
  free(d);
  if (destroy) destroy(device, alloc);
}

// ---- Dispatch ---------------------------------------------------------------------------

EXPORT VKAPI_ATTR PFN_vkVoidFunction VKAPI_CALL din_GetDeviceProcAddr(VkDevice device, const char *name);

struct named { const char *name; PFN_vkVoidFunction fn; };
#define F(n, f) { n, (PFN_vkVoidFunction)f }
static const struct named wrapped_fns[] = {
  F("vkQueueSubmit", w_QueueSubmit), F("vkQueueWaitIdle", w_QueueWaitIdle),
  F("vkCreateBuffer", w_CreateBuffer), F("vkDestroyBuffer", w_DestroyBuffer),
  F("vkUpdateDescriptorSets", w_UpdateDescriptorSets),
  F("vkUpdateDescriptorSetWithTemplate", w_UpdateDescriptorSetWithTemplate),
  F("vkUpdateDescriptorSetWithTemplateKHR", w_UpdateDescriptorSetWithTemplate),
  F("vkCreateDescriptorUpdateTemplate", w_CreateDescriptorUpdateTemplate),
  F("vkCreateDescriptorUpdateTemplateKHR", w_CreateDescriptorUpdateTemplate),
  F("vkDestroyDescriptorUpdateTemplate", w_DestroyDescriptorUpdateTemplate),
  F("vkDestroyDescriptorUpdateTemplateKHR", w_DestroyDescriptorUpdateTemplate),
  F("vkAllocateCommandBuffers", w_AllocateCommandBuffers), F("vkFreeCommandBuffers", w_FreeCommandBuffers),
  F("vkDestroyCommandPool", w_DestroyCommandPool), F("vkBeginCommandBuffer", w_BeginCommandBuffer),
  F("vkResetCommandBuffer", w_ResetCommandBuffer),
  F("vkCmdBindPipeline", w_CmdBindPipeline), F("vkCmdBindDescriptorSets", w_CmdBindDescriptorSets),
  F("vkCmdPushConstants", w_CmdPushConstants), F("vkCmdDispatch", w_CmdDispatch),
  F("vkCmdDispatchBase", w_CmdDispatchBase), F("vkCmdDispatchBaseKHR", w_CmdDispatchBase),
  F("vkCmdDispatchIndirect", w_CmdDispatchIndirect), F("vkCmdCopyBuffer", w_CmdCopyBuffer),
  F("vkCmdFillBuffer", w_CmdFillBuffer), F("vkCmdUpdateBuffer", w_CmdUpdateBuffer),
  F("vkCmdPipelineBarrier", w_CmdPipelineBarrier),
  F("vkCmdBeginDebugUtilsLabelEXT", w_CmdBeginDebugUtilsLabelEXT),
  F("vkCmdEndDebugUtilsLabelEXT", w_CmdEndDebugUtilsLabelEXT),
  F("vkCmdInsertDebugUtilsLabelEXT", w_CmdInsertDebugUtilsLabelEXT),
};

EXPORT VKAPI_ATTR PFN_vkVoidFunction VKAPI_CALL din_GetDeviceProcAddr(VkDevice device, const char *name) {
  if (!strcmp(name, "vkGetDeviceProcAddr")) return (PFN_vkVoidFunction)din_GetDeviceProcAddr;
  if (!strcmp(name, "vkDestroyDevice")) return (PFN_vkVoidFunction)layer_DestroyDevice;
  if (!device) return NULL;
  struct dev *d = find_dev(key_of(device));
  if (!d) return NULL;
  PFN_vkVoidFunction next = d->gdpa(device, name);
  if (!d->wrapped || !next) return next;
  for (size_t i = 0; i < sizeof wrapped_fns / sizeof *wrapped_fns; i++)
    if (!strcmp(name, wrapped_fns[i].name)) return wrapped_fns[i].fn;
  for (int i = 0; i < GEN_CMD_COUNT; i++) {
    if (!strcmp(name, gen_cmd_names[i])) { d->next_cmd[i] = (void *)next; return gen_cmd_funcs[i]; }
  }
  if (!strncmp(name, "vkCmd", 5)) {
    // A command the headers this was built with don't know: it can't be
    // watched, so nothing of this device's goes to the compute queue.
    pthread_mutex_lock(&d->lock);
    if (d->use_compute) DEBUG("%s isn't known; leaving Dawn's work on the graphics queue\n", name);
    d->use_compute = false;
    pthread_mutex_unlock(&d->lock);
  }
  return next;
}

EXPORT VKAPI_ATTR PFN_vkVoidFunction VKAPI_CALL din_GetInstanceProcAddr(VkInstance instance, const char *name) {
  if (!strcmp(name, "vkGetInstanceProcAddr")) return (PFN_vkVoidFunction)din_GetInstanceProcAddr;
  if (!strcmp(name, "vkCreateInstance")) return (PFN_vkVoidFunction)layer_CreateInstance;
  if (!strcmp(name, "vkDestroyInstance")) return (PFN_vkVoidFunction)layer_DestroyInstance;
  if (!strcmp(name, "vkCreateDevice")) return (PFN_vkVoidFunction)layer_CreateDevice;
  if (!strcmp(name, "vkGetDeviceProcAddr")) return (PFN_vkVoidFunction)din_GetDeviceProcAddr;
  if (!strcmp(name, "vkDestroyDevice")) return (PFN_vkVoidFunction)layer_DestroyDevice;
  if (!instance) return NULL;
  struct instance_data *data = find_instance(key_of(instance));
  PFN_vkGetInstanceProcAddr next = data ? data->gipa : NULL;
  return next ? next(instance, name) : NULL;
}

EXPORT VKAPI_ATTR VkResult VKAPI_CALL vkNegotiateLoaderLayerInterfaceVersion(VkNegotiateLayerInterface *v) {
  if (!v || v->sType != LAYER_NEGOTIATE_INTERFACE_STRUCT) return VK_ERROR_INITIALIZATION_FAILED;
  if (v->loaderLayerInterfaceVersion > 2) v->loaderLayerInterfaceVersion = 2;
  v->pfnGetInstanceProcAddr = din_GetInstanceProcAddr;
  v->pfnGetDeviceProcAddr = din_GetDeviceProcAddr;
  v->pfnGetPhysicalDeviceProcAddr = NULL;
  return VK_SUCCESS;
}
