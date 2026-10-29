import { connect } from '@/sdk';
import { startApp } from '@/sdk/start';

// The player reads its saved state as its modules load: only once connect()
// has copied in what it kept on the desktop's origin before it moved.
void connect().then(async () => {
  const { MediaPlayer } = await import('./MediaPlayer');
  await startApp(() => <MediaPlayer />);
});
