import { uploadWindowParams } from '@/lib/blossomUpload';
import type { Din } from '@/sdk';
import { windowLaunchFiles } from '@/shared/fileHandles';
import { appLink, windowLaunch } from '@/shared/launch';

/** Open the upload window for these files (Upload to Blossom…), handing it the files. */
export async function openUploadWindow(din: Din, paths: string[]): Promise<void> {
  const handles = await Promise.all(paths.map((p) => din.files.fromPath(p)));
  await din.app.launch(appLink('file-browser', uploadWindowParams(handles.length)), handles);
}

/** Whether this window was opened to upload files, and which: the files it was launched with. */
export function uploadWindowFiles(): FileSystemFileHandle[] | null {
  if (windowLaunch().params.window !== 'upload') return null;
  return windowLaunchFiles().filter((h): h is FileSystemFileHandle => h.kind === 'file');
}
