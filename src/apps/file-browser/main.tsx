import { startApp } from '@/sdk/start';
import { FileBrowser } from './FileBrowser';
import { UploadWindow } from './files/UploadWindow';
import { uploadWindowFiles } from './files/upload';

void startApp(() => {
  const upload = uploadWindowFiles();
  return upload ? <UploadWindow files={upload} /> : <FileBrowser />;
});
