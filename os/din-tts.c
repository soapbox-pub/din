/*
 * din-tts: Din's voice, kept loaded (electron/speech.mts).
 *
 * sherpa-onnx's command-line TTS loads Kokoro's 300 MB model for every
 * sentence, most of a second each time. This keeps it loaded and answers
 * sentence after sentence: it's started with the path of sherpa-onnx's C
 * library (the Speech optional feature's, opened here so the system doesn't
 * carry it), the model's folder and how many threads to use, then reads
 * requests from stdin, one per line:
 *
 *   <speaker id> <speed> <text>\n
 *
 * and answers each on stdout with a little-endian int32 sample count (-1 if
 * it failed), an int32 sample rate, and that many int16 samples. Once the
 * model is loaded it writes "DTTS" and the sample rate, so the caller knows
 * it's ready.
 */

#include <dlfcn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "sherpa-onnx/c-api/c-api.h"

typedef const SherpaOnnxOfflineTts *(*create_fn)(const SherpaOnnxOfflineTtsConfig *);
typedef const SherpaOnnxGeneratedAudio *(*generate_fn)(const SherpaOnnxOfflineTts *, const char *, int32_t, float);
typedef void (*destroy_audio_fn)(const SherpaOnnxGeneratedAudio *);
typedef int32_t (*rate_fn)(const SherpaOnnxOfflineTts *);

static void put32(int32_t v) {
  unsigned char b[4] = {v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff};
  fwrite(b, 1, 4, stdout);
}

static char *join(const char *dir, const char *name) {
  size_t n = strlen(dir) + strlen(name) + 2;
  char *path = malloc(n);
  snprintf(path, n, "%s/%s", dir, name);
  return path;
}

int main(int argc, char **argv) {
  if (argc != 4) {
    fprintf(stderr, "usage: din-tts <libsherpa-onnx-c-api.so> <model folder> <threads>\n");
    return 2;
  }
  void *lib = dlopen(argv[1], RTLD_NOW);
  if (!lib) {
    fprintf(stderr, "din-tts: %s\n", dlerror());
    return 1;
  }
  create_fn create = (create_fn)dlsym(lib, "SherpaOnnxCreateOfflineTts");
  generate_fn generate = (generate_fn)dlsym(lib, "SherpaOnnxOfflineTtsGenerate");
  destroy_audio_fn destroy_audio = (destroy_audio_fn)dlsym(lib, "SherpaOnnxDestroyOfflineTtsGeneratedAudio");
  rate_fn sample_rate = (rate_fn)dlsym(lib, "SherpaOnnxOfflineTtsSampleRate");
  if (!create || !generate || !destroy_audio || !sample_rate) {
    fprintf(stderr, "din-tts: sherpa-onnx's library lacks the TTS API\n");
    return 1;
  }

  const char *dir = argv[2];
  SherpaOnnxOfflineTtsConfig config;
  memset(&config, 0, sizeof config);
  config.model.kokoro.model = join(dir, "model.onnx");
  config.model.kokoro.voices = join(dir, "voices.bin");
  config.model.kokoro.tokens = join(dir, "tokens.txt");
  config.model.kokoro.data_dir = join(dir, "espeak-ng-data");
  config.model.kokoro.lexicon = join(dir, "lexicon-us-en.txt");
  config.model.kokoro.lang = "en";
  config.model.kokoro.length_scale = 1.0f;
  config.model.num_threads = atoi(argv[3]) > 0 ? atoi(argv[3]) : 2;
  config.model.provider = "cpu";
  config.max_num_sentences = 1;
  config.silence_scale = 0.2f;

  const SherpaOnnxOfflineTts *tts = create(&config);
  if (!tts) {
    fprintf(stderr, "din-tts: couldn't load the model in %s\n", dir);
    return 1;
  }
  int32_t rate = sample_rate(tts);
  fwrite("DTTS", 1, 4, stdout);
  put32(rate);
  fflush(stdout);

  char *line = NULL;
  size_t size = 0;
  ssize_t length;
  while ((length = getline(&line, &size, stdin)) > 0) {
    if (line[length - 1] == '\n') line[length - 1] = '\0';
    char *rest = line;
    long sid = strtol(rest, &rest, 10);
    float speed = strtof(rest, &rest);
    if (*rest == ' ') rest++;
    if (speed < 0.5f || speed > 2.0f) speed = 1.0f;
    const SherpaOnnxGeneratedAudio *audio = *rest ? generate(tts, rest, (int32_t)sid, speed) : NULL;
    if (!audio || audio->n <= 0) {
      put32(-1);
      put32(rate);
      if (audio) destroy_audio(audio);
      fflush(stdout);
      continue;
    }
    put32(audio->n);
    put32(audio->sample_rate);
    int16_t *pcm = malloc(sizeof(int16_t) * (size_t)audio->n);
    for (int32_t i = 0; i < audio->n; i++) {
      float s = audio->samples[i];
      s = s > 1.0f ? 1.0f : s < -1.0f ? -1.0f : s;
      int16_t v = (int16_t)(s * 32767.0f);
      unsigned char *b = (unsigned char *)&pcm[i];
      b[0] = v & 0xff;
      b[1] = (v >> 8) & 0xff;
    }
    fwrite(pcm, sizeof(int16_t), (size_t)audio->n, stdout);
    free(pcm);
    destroy_audio(audio);
    fflush(stdout);
  }
  free(line);
  return 0;
}
