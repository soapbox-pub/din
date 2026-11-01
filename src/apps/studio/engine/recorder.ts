import type { CaptureBridge, SceneSwitch, StudioAspect, StudioScene, TakeInfo, TakeMarker, TrackStart } from '@/lib/capture';

/**
 * One take: Studio's own recorders (the picture, the camera, the microphone)
 * writing into the take's folder a second at a time, while main records the
 * screen. They all start in the same moment, which is the take's clock's
 * zero; the screen's place on it comes back from main.
 */

/** H.264 and Opus in Matroska: what Chromium encodes, and what FFmpeg copies into an MP4 or onto RTMP. */
const VIDEO_TYPE = 'video/webm;codecs=h264,opus';
const VIDEO_ONLY_TYPE = 'video/webm;codecs=h264';
const AUDIO_TYPE = 'audio/webm;codecs=opus';

/** Chromium's keyframe spacing, which TypeScript's DOM types don't know yet. */
type RecorderOptions = MediaRecorderOptions & { videoKeyFrameIntervalDuration?: number };

/** A MediaRecorder whose chunks go, in order, to a function that takes bytes. */
export class ChunkRecorder {
  readonly recorder: MediaRecorder;
  private queue: Promise<void> = Promise.resolve();
  private failed: unknown = null;

  constructor(stream: MediaStream, options: RecorderOptions, sink: (bytes: Uint8Array) => Promise<void> | void) {
    this.recorder = new MediaRecorder(stream, options);
    this.recorder.ondataavailable = (event) => {
      if (event.data.size === 0) return;
      const blob = event.data;
      this.queue = this.queue.then(async () => {
        if (this.failed) return;
        try {
          await sink(new Uint8Array(await blob.arrayBuffer()));
        } catch (error) {
          this.failed = error;
        }
      });
    };
  }

  start(timeslice: number): void {
    this.recorder.start(timeslice);
  }

  /** Stop, and resolve once every chunk has gone. */
  async stop(): Promise<void> {
    if (this.recorder.state !== 'inactive') {
      const stopped = new Promise<void>((resolve) => this.recorder.addEventListener('stop', () => resolve(), { once: true }));
      this.recorder.stop();
      await stopped;
    }
    await this.queue;
    if (this.failed) throw this.failed;
  }
}

export interface TakeSources {
  /** The composed picture. */
  program: MediaStreamTrack;
  /** The mix of the microphone and the computer's sound, if any. */
  mix: MediaStreamTrack | null;
  camera: MediaStreamTrack | null;
  mic: MediaStreamTrack | null;
  mirrored: boolean;
  /** What the mix holds, for take.json. */
  mixAudio: string | null;
}

export interface TakeOptions {
  scene: StudioScene;
  aspect: StudioAspect;
  canvas: { width: number; height: number };
  /** Record the screen too, with the computer's sound or not. */
  screen: { audio: boolean } | null;
  /** The picture now, for the take's poster. */
  poster: () => Promise<Blob | null>;
}

export class TakeRecorder {
  readonly take: string;
  readonly title: string;
  readonly startedAt: number;
  private bridge: CaptureBridge;
  private tracks: { name: 'program' | 'camera' | 'mic'; recorder: ChunkRecorder; writer: string; start: TrackStart }[];
  private switches: SceneSwitch[] = [];
  private markers: TakeMarker[] = [];
  private posterTimer: ReturnType<typeof setTimeout>;

  private constructor(
    bridge: CaptureBridge,
    take: string,
    title: string,
    startedAt: number,
    tracks: TakeRecorder['tracks'],
    poster: () => Promise<Blob | null>,
  ) {
    this.bridge = bridge;
    this.take = take;
    this.title = title;
    this.startedAt = startedAt;
    this.tracks = tracks;
    // A frame from a moment in, once the picture has settled.
    this.posterTimer = setTimeout(() => void this.savePoster(poster), 1500);
  }

  static async start(bridge: CaptureBridge, sources: TakeSources, options: TakeOptions): Promise<TakeRecorder> {
    const begun = await bridge.begin({ scene: options.scene, aspect: options.aspect, canvas: options.canvas, screen: options.screen });
    const planned: { name: 'program' | 'camera' | 'mic'; stream: MediaStream; options: RecorderOptions; file: string; meta: Partial<TrackStart> }[] = [];
    planned.push({
      name: 'program',
      stream: new MediaStream(sources.mix ? [sources.program, sources.mix] : [sources.program]),
      options: { mimeType: sources.mix ? VIDEO_TYPE : VIDEO_ONLY_TYPE, videoBitsPerSecond: 10_000_000, audioBitsPerSecond: 160_000, videoKeyFrameIntervalDuration: 2000 },
      file: '.program.webm',
      meta: { ...options.canvas, ...(sources.mixAudio ? { audio: sources.mixAudio } : {}) },
    });
    if (sources.camera) {
      const settings = sources.camera.getSettings();
      planned.push({
        name: 'camera',
        stream: new MediaStream([sources.camera]),
        options: { mimeType: VIDEO_ONLY_TYPE, videoBitsPerSecond: 8_000_000, videoKeyFrameIntervalDuration: 2000 },
        file: '.camera.webm',
        meta: { width: settings.width, height: settings.height, mirrored: sources.mirrored },
      });
    }
    if (sources.mic) {
      planned.push({
        name: 'mic',
        stream: new MediaStream([sources.mic]),
        options: { mimeType: AUDIO_TYPE, audioBitsPerSecond: 192_000 },
        file: '.mic.webm',
        meta: { audio: 'voice' },
      });
    }

    const tracks: TakeRecorder['tracks'] = [];
    try {
      for (const plan of planned) {
        const writer = await bridge.open(begun.take, plan.file);
        const recorder = new ChunkRecorder(plan.stream, plan.options, (bytes) => bridge.write(writer, bytes));
        tracks.push({ name: plan.name, recorder, writer, start: { file: plan.file, start: 0, ...plan.meta } });
      }
    } catch (error) {
      await bridge.end({ startedAt: Date.now(), durationMs: 0, tracks: {}, switches: [], markers: [], discard: true }).catch(() => {});
      throw error;
    }
    // All at once: this moment is the take's zero.
    const startedAt = Date.now();
    for (const track of tracks) {
      track.start.start = startedAt;
      track.recorder.start(1000);
    }
    return new TakeRecorder(bridge, begun.take, begun.title, startedAt, tracks, options.poster);
  }

  /** The layout changed: written down, so the Assistant knows what was on screen when. */
  addSwitch(change: Omit<SceneSwitch, 'at'>): void {
    const last = this.switches.at(-1);
    // The first is the layout the take started with.
    const at = last ? Date.now() : this.startedAt;
    if (last && at - last.at < 400) this.switches[this.switches.length - 1] = { ...change, at: last.at };
    else this.switches.push({ ...change, at });
  }

  mark(kind: TakeMarker['kind']): void {
    this.markers.push({ at: Date.now(), kind });
  }

  get markerCount(): number {
    return this.markers.length;
  }

  private async savePoster(poster: () => Promise<Blob | null>): Promise<void> {
    try {
      const blob = await poster();
      if (!blob) return;
      const writer = await this.bridge.open(this.take, 'poster.jpg');
      await this.bridge.write(writer, new Uint8Array(await blob.arrayBuffer()));
      await this.bridge.close(writer);
    } catch {
      // The take has no poster; its list shows a placeholder.
    }
  }

  /** End the take: the files are finished and take.json written. Null when discarded. */
  async stop(discard = false): Promise<TakeInfo | null> {
    clearTimeout(this.posterTimer);
    const durationMs = Date.now() - this.startedAt;
    const results = await Promise.allSettled(this.tracks.map((t) => t.recorder.stop()));
    await Promise.all(this.tracks.map((t) => this.bridge.close(t.writer).catch(() => {})));
    if (!discard) {
      const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failed) console.error('studio: a track stopped writing:', failed.reason);
    }
    const tracks: Partial<Record<'program' | 'camera' | 'mic', TrackStart>> = {};
    for (const t of this.tracks) tracks[t.name] = t.start;
    return this.bridge.end({
      startedAt: this.startedAt,
      durationMs,
      tracks,
      switches: this.switches,
      markers: this.markers,
      discard,
    });
  }
}

/** Going live: the picture and the mix, encoded here, sent to main as they come. */
export class LiveSender {
  private recorder: ChunkRecorder;

  private constructor(recorder: ChunkRecorder) {
    this.recorder = recorder;
  }

  static async start(bridge: CaptureBridge, destination: string, program: MediaStreamTrack, mix: MediaStreamTrack | null, height: number): Promise<LiveSender> {
    await bridge.streamStart(destination);
    const stream = new MediaStream(mix ? [program, mix] : [program]);
    const recorder = new ChunkRecorder(
      stream,
      {
        mimeType: mix ? VIDEO_TYPE : VIDEO_ONLY_TYPE,
        // Services' advice for 1080p30: 4.5 to 6 Mbps, a keyframe every two seconds.
        videoBitsPerSecond: height >= 1080 ? 6_000_000 : 4_500_000,
        audioBitsPerSecond: 160_000,
        videoKeyFrameIntervalDuration: 2000,
      },
      (bytes) => bridge.streamWrite(bytes),
    );
    recorder.start(250);
    return new LiveSender(recorder);
  }

  /** Stop encoding; main ends the stream once what's sent has gone. */
  async stop(): Promise<void> {
    await this.recorder.stop().catch(() => {});
  }
}
