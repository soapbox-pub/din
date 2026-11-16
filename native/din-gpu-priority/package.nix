# The Vulkan layer that keeps web pages' WebGPU work from holding up the
# desktop (layer.c says how). An implicit layer: Din's launcher points the
# Vulkan loader at share/vulkan/implicit_layer.d and sets DIN_GPU_PRIORITY=1,
# which is what turns it on.
{ stdenv, python3, vulkan-headers }:

stdenv.mkDerivation {
  pname = "din-gpu-priority";
  version = "0.1.0";
  src = ./.;
  nativeBuildInputs = [ python3 ];
  buildInputs = [ vulkan-headers ];
  dontConfigure = true;
  buildPhase = ''
    runHook preBuild
    python3 gen-cmds.py ${vulkan-headers}/include/vulkan/vulkan_core.h cmds-decl.h cmds.h
    $CC -O2 -Wall -Wextra -Werror -Wno-unused-parameter -fPIC -shared -fvisibility=hidden \
      -o libdin_gpu_priority.so layer.c -lpthread
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    install -Dm444 libdin_gpu_priority.so $out/lib/libdin_gpu_priority.so
    mkdir -p $out/share/vulkan/implicit_layer.d
    cat > $out/share/vulkan/implicit_layer.d/din_gpu_priority.json <<EOF
    {
      "file_format_version": "1.2.0",
      "layer": {
        "name": "VK_LAYER_DIN_gpu_priority",
        "type": "GLOBAL",
        "library_path": "$out/lib/libdin_gpu_priority.so",
        "api_version": "1.3.0",
        "implementation_version": "1",
        "description": "Keeps WebGPU's work (Dawn's) from holding up the desktop: compute on its own queue, low priority",
        "functions": {
          "vkGetInstanceProcAddr": "din_GetInstanceProcAddr",
          "vkGetDeviceProcAddr": "din_GetDeviceProcAddr"
        },
        "enable_environment": { "DIN_GPU_PRIORITY": "1" },
        "disable_environment": { "DIN_GPU_PRIORITY_DISABLE": "1" }
      }
    }
    EOF
    runHook postInstall
  '';
}
