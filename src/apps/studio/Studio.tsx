import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Clapperboard, Monitor, MonitorSmartphone, PanelRight, RectangleHorizontal, RectangleVertical, Square, User } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { cleanCaptureError, type CaptureRect, type CaptureStatus, type LiveStatus, type ProjectChange, type ProjectInfo, type ProjectItem, type StudioAspect, type StudioScene } from '@/lib/capture';
import { cn } from '@/lib/utils';
import { canOpenApp, onLaunch, wasReopened, windowLaunch, type Launch } from '@/shared/launch';
import { useCloseGuard, useDin, useDocumentVisible, useMenuBar, useWindowTitle, WindowControls, WindowDragRegion } from '@/sdk/react';
import { AudioMixer } from './engine/audio';
import { Compositor } from './engine/compositor';
import { asFraction, CANVAS, type Bubble, type Layout } from './engine/layout';
import { useCapture, useDevices } from './engine/media';
import { LiveSender, TakeRecorder } from './engine/recorder';
import { useStudioSettings } from './settings';
import { formatTime } from './format';
import { forgetFileUrl, useProjects, type ItemAction, type ProjectAction } from './takes';
import { Controls, type Phase } from './ui/Controls';
import { GoLiveDialog } from './ui/GoLive';
import { MakeView } from './ui/MakeView';
import { ProjectPanel } from './ui/ProjectPanel';
import { ProjectSwitcher } from './ui/ProjectSwitcher';
import { Segmented } from './ui/Segmented';
import { Stage } from './ui/Stage';
import { TakeView, type ItemChange } from './ui/TakeView';

/** What Add Clips offers to pick. */
const CLIP_TYPES = [
  {
    description: 'Videos and sound',
    accept: {
      'video/*': ['.mp4', '.mov', '.mkv', '.webm', '.m4v', '.avi'],
      'audio/*': ['.mp3', '.m4a', '.wav', '.ogg', '.opus', '.flac'],
    },
  },
];

/** How much of a clip goes to main at once. */
const CLIP_CHUNK = 8 * 1024 * 1024;

const SCENES: { value: StudioScene; label: string; icon: React.ReactNode }[] = [
  { value: 'screen-camera', label: 'Screen and Camera', icon: <MonitorSmartphone className="size-4" aria-hidden /> },
  { value: 'camera', label: 'Camera', icon: <User className="size-4" aria-hidden /> },
  { value: 'screen', label: 'Screen', icon: <Monitor className="size-4" aria-hidden /> },
];

const ASPECTS: { value: StudioAspect; label: string; icon: React.ReactNode }[] = [
  { value: '16:9', label: 'Landscape 16:9, for YouTube', icon: <RectangleHorizontal className="size-4" aria-hidden /> },
  { value: '9:16', label: 'Portrait 9:16, for TikTok, Reels and Shorts', icon: <RectangleVertical className="size-4" aria-hidden /> },
  { value: '1:1', label: 'Square 1:1', icon: <Square className="size-4" aria-hidden /> },
];

/** What Studio was asked to do from outside: `din studio`, the menu bar's stop button. */
interface Action {
  action: 'record' | 'stop' | 'mark' | 'live' | 'project';
  nonce: unknown;
  scene?: StudioScene;
  aspect?: StudioAspect;
  kind?: 'highlight' | 'retake';
  destination?: string;
  /** The project to record into, by its folder. */
  project?: string;
}

function actionOf({ params }: Pick<Launch, 'params'>, reopened = false): Action | null {
  // A window Din reopens keeps its last params: what they asked for was done then.
  if (reopened) return null;
  const { action, nonce } = params;
  if (action !== 'record' && action !== 'stop' && action !== 'mark' && action !== 'live' && action !== 'project') return null;
  const scene = params.scene === 'screen-camera' || params.scene === 'camera' || params.scene === 'screen' ? params.scene : undefined;
  const aspect = params.aspect === '16:9' || params.aspect === '9:16' || params.aspect === '1:1' ? params.aspect : undefined;
  return {
    action,
    nonce,
    scene,
    aspect,
    kind: params.kind === 'retake' ? 'retake' : 'highlight',
    destination: typeof params.destination === 'string' ? params.destination : undefined,
    project: typeof params.project === 'string' && params.project.startsWith('/') ? params.project : undefined,
  };
}

/**
 * Studio: record yourself and the screen, for the Assistant to edit, or go
 * live. Takes go into a project, as many as it takes, beside clips brought
 * in; the user sets their order and which to use, and the Assistant makes
 * one thing from the project. One picture (the stage) is what's recorded and
 * streamed; each take also keeps the screen, the camera and the microphone
 * apart, with a transcript, so the Assistant can cut it on words and
 * reframe it.
 */
export function Studio() {
  const din = useDin();
  const capture = din.system.capture;
  const visible = useDocumentVisible();
  const [settings, update] = useStudioSettings();
  const [status, setStatus] = useState<CaptureStatus | null>(null);
  const devices = useDevices();
  const [phase, setPhase] = useState<Phase>('idle');
  const [count, setCount] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [markers, setMarkers] = useState(0);
  /** When the take being recorded started. */
  const [takeStart, setTakeStart] = useState<number | null>(null);
  const [live, setLive] = useState<LiveStatus | null>(null);
  const [view, setView] = useState<{ kind: 'take'; take: string } | { kind: 'make'; focus: number } | null>(null);
  const [showProject, setShowProject] = useState(true);
  const showProjectRef = useRef(showProject);
  useEffect(() => {
    showProjectRef.current = showProject;
  }, [showProject]);
  const [goLiveOpen, setGoLiveOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renamingProject, setRenamingProject] = useState(false);
  const [trashing, setTrashing] = useState<{ item: ProjectItem } | { project: ProjectInfo } | null>(null);
  /** The take just recorded or clip just added, shown so in the project. */
  const [fresh, setFresh] = useState<string | null>(null);
  const [importing, setImporting] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [canAssist, setCanAssist] = useState(false);
  const { projects, loading, put, refresh } = useProjects(capture);
  const project = (settings.project && projects.find((p) => p.path === settings.project)) || null;
  /** The project the next take goes into: kept in a ref, so a take asked for from outside goes where it said. */
  const target = useRef<string | null>(null);
  // Until the projects are listed, the one Studio had open.
  const wanted = loading ? settings.project || null : project?.path ?? null;
  useEffect(() => {
    target.current = wanted;
  }, [wanted]);

  const take = useRef<TakeRecorder | null>(null);
  const sender = useRef<LiveSender | null>(null);
  /** The take was started by going live, and ends with the stream. */
  const takeWithLive = useRef(false);
  const busy = phase !== 'idle' || live !== null;

  useEffect(() => {
    if (!capture) return;
    let alive = true;
    capture.status().then((s) => {
      if (!alive) return;
      setStatus(s);
      setLive(s.state.live);
    }, () => {});
    const offState = capture.onState((state) => setLive(state.live));
    const offEnded = capture.onStreamEnded((ended) => {
      if (ended.error) setNotice(`The stream on ${ended.destination} ended: ${ended.error}`);
    });
    return () => {
      alive = false;
      offState();
      offEnded();
    };
  }, [capture]);

  useEffect(() => {
    let alive = true;
    canOpenApp('assistant').then((can) => alive && setCanAssist(can), () => {});
    return () => {
      alive = false;
    };
  }, [din]);

  // ---- what's captured ----
  // While recording or live, nothing that was on is turned off: its track is being recorded.
  const [held, setHeld] = useState({ camera: false, screen: false });
  // Hidden for a moment (a window over it, a look at another workspace), what's captured keeps
  // running: starting the camera and the screen again takes seconds.
  const [cold, setCold] = useState(!visible);
  useEffect(() => {
    if (visible) return;
    const timer = setTimeout(() => setCold(true), 30_000);
    return () => {
      clearTimeout(timer);
      setCold(false);
    };
  }, [visible]);
  const active = visible || !cold || busy;
  const wantsCamera = settings.cameraOn && settings.scene !== 'screen';
  const wantsScreen = settings.scene !== 'camera';
  const cameraOn = active && (wantsCamera || (busy && held.camera));
  const screenOn = active && (wantsScreen || (busy && held.screen)) && !!capture;
  const cam = useCapture(
    cameraOn ? `camera:${settings.camera}` : null,
    () =>
      navigator.mediaDevices.getUserMedia({
        video: {
          ...(settings.camera ? { deviceId: { exact: settings.camera } } : {}),
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30 },
        },
      }),
    'camera',
  );
  const mic = useCapture(
    active && settings.micOn ? `mic:${settings.mic}` : null,
    () =>
      navigator.mediaDevices.getUserMedia({
        audio: {
          ...(settings.mic ? { deviceId: { exact: settings.mic } } : {}),
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      }),
    'microphone',
  );
  // The capture is of Din's whole frame, of which the picture shows the display: asked for at the
  // size that puts the display at the picture's own (1920 at most), not more. Every pixel of it is
  // read back from the GPU and drawn again each frame, and main records the screen itself.
  const shot = status && captureSize(status.screenRect);
  const scr = useCapture(
    screenOn && shot ? `screen:${shot.width}x${shot.height}` : null,
    () => navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30 }, width: { max: shot!.width }, height: { max: shot!.height } }, audio: false }),
    'screen',
  );
  // The computer's sound, where it's offered as an input, goes into the picture's sound too.
  const monitor = devices.monitors[0];
  const sys = useCapture(
    active && settings.computerSound && monitor ? `system:${monitor.deviceId}` : null,
    () =>
      navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: monitor!.deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      }),
    'computer’s sound',
  );

  // ---- the picture and the sound ----
  const layout: Layout = useMemo(
    () => ({ scene: settings.scene, aspect: settings.aspect, shape: settings.shape, bubbles: settings.bubbles }),
    [settings.scene, settings.aspect, settings.shape, settings.bubbles],
  );
  const [compositor] = useState(() => new Compositor(layout));
  const [mixer] = useState(() => new AudioMixer());
  const [program] = useState(() => compositor.captureStream().getVideoTracks()[0]);
  useEffect(() => {
    compositor.start();
    return () => {
      compositor.dispose();
      mixer.dispose();
    };
  }, [compositor, mixer]);
  useEffect(() => compositor.setLayout(layout), [compositor, layout]);
  useEffect(() => compositor.setMirror(settings.mirror), [compositor, settings.mirror]);
  useEffect(() => compositor.setCamera(cam.stream?.getVideoTracks()[0] ?? null), [compositor, cam.stream]);
  useEffect(() => compositor.setScreen(scr.stream?.getVideoTracks()[0] ?? null), [compositor, scr.stream]);
  useEffect(() => {
    if (status) compositor.setScreenCrop(status.screenRect);
  }, [compositor, status]);
  useEffect(() => mixer.setMic(mic.stream), [mixer, mic.stream]);
  useEffect(() => mixer.setSystem(sys.stream), [mixer, sys.stream]);

  // The pointer's own arrow, as the cursor theme draws it, read again with each capture of the screen.
  useEffect(() => {
    if (!capture || !scr.stream) return;
    let cancelled = false;
    capture.pointerImage().then(
      async (arrow) => {
        if (!arrow) return;
        const pixels = new Uint8ClampedArray(arrow.rgba.length);
        pixels.set(arrow.rgba);
        const source = await createImageBitmap(new ImageData(pixels, arrow.width, arrow.height));
        if (cancelled) return;
        // The theme's image is drawn `size` pixels big on the display.
        const k = arrow.size / Math.max(arrow.width, arrow.height, 1);
        compositor.setPointerImage({
          source,
          width: arrow.width * k,
          height: arrow.height * k,
          hotX: arrow.hotX * k,
          hotY: arrow.hotY * k,
          displayHeight: arrow.displayHeight,
        });
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [capture, compositor, scr.stream]);

  // The pointer, polled on the compositor's own clock so it keeps up while Studio is minimized.
  useEffect(() => {
    if (!capture || !scr.stream) {
      compositor.setPointer(null);
      return;
    }
    let pending = false;
    return compositor.onTick(() => {
      if (pending) return;
      pending = true;
      capture.pointer().then(
        (p) => {
          compositor.setPointer(p);
          pending = false;
        },
        () => {
          pending = false;
        },
      );
    });
  }, [capture, compositor, scr.stream]);

  // Scene and layout changes during a take are written down for the Assistant.
  useEffect(() => {
    const t = take.current;
    if (!t || phase !== 'recording') return;
    const canvas = CANVAS[layout.aspect];
    // After the next frame, so it's what's drawn.
    const timer = setTimeout(() => {
      const frame = compositor.frame;
      t.addSwitch({
        scene: layout.scene,
        camera: frame.camera ? { ...asFraction(frame.camera, canvas)!, shape: frame.cameraClip === 'circle' ? 'circle' : frame.cameraClip > 0 ? 'rounded' : 'rectangle' } : null,
        screen: asFraction(frame.screen, canvas),
      });
    }, 80);
    return () => clearTimeout(timer);
  }, [compositor, layout, phase, cam.stream, scr.stream]);

  // The clock while recording.
  useEffect(() => {
    if (phase !== 'recording' && !live) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [phase, live]);

  // ---- recording ----
  const countdownTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const startTake = useCallback(async (): Promise<void> => {
    if (!capture) return;
    setPhase('starting');
    setNotice(null);
    try {
      await mixer.resume();
      // Going live already holds what it needs; a take adds what it records.
      setHeld((h) => (sender.current ? { camera: h.camera || !!cam.stream, screen: h.screen || !!scr.stream } : { camera: !!cam.stream, screen: !!scr.stream }));
      const hasMic = !!mixer.micTrack;
      const recorder = await TakeRecorder.start(
        capture,
        {
          program,
          mix: hasMic || mixer.hasSystem ? mixer.track : null,
          camera: cam.stream?.getVideoTracks()[0] ?? null,
          mic: mixer.micTrack,
          mirrored: settings.mirror,
          mixAudio: hasMic && mixer.hasSystem ? 'voice+computer' : hasMic ? 'voice' : mixer.hasSystem ? 'computer' : null,
        },
        {
          project: target.current,
          scene: settings.scene,
          aspect: settings.aspect,
          canvas: CANVAS[settings.aspect],
          screen: scr.stream ? { audio: settings.computerSound } : null,
          poster: () => compositor.snapshot(),
        },
      );
      take.current = recorder;
      target.current = recorder.project;
      update({ project: recorder.project });
      setFresh(recorder.take);
      setTakeStart(recorder.startedAt);
      setMarkers(0);
      setNow(Date.now());
      setPhase('recording');
      if (settings.hideWhileRecording && scr.stream && !takeWithLive.current) void window.minimize();
    } catch (error) {
      setPhase('idle');
      setNotice(`Couldn’t start recording: ${cleanCaptureError(error)}`);
    }
  }, [capture, cam.stream, compositor, mixer, program, scr.stream, settings, update]);

  const record = useCallback(() => {
    if (phase !== 'idle' || !capture) return;
    setView(null);
    if (settings.countdown <= 0) {
      void startTake();
      return;
    }
    let left = settings.countdown;
    setCount(left);
    setPhase('countdown');
    countdownTimer.current = setInterval(() => {
      left -= 1;
      if (left > 0) {
        setCount(left);
        return;
      }
      clearInterval(countdownTimer.current!);
      countdownTimer.current = null;
      setCount(null);
      void startTake();
    }, 1000);
  }, [phase, capture, settings.countdown, startTake]);

  const cancelCountdown = useCallback(() => {
    if (countdownTimer.current) clearInterval(countdownTimer.current);
    countdownTimer.current = null;
    setCount(null);
    setPhase('idle');
  }, []);

  const stop = useCallback(async () => {
    const t = take.current;
    if (!t || phase !== 'recording') return;
    setPhase('stopping');
    take.current = null;
    setTakeStart(null);
    takeWithLive.current = false;
    try {
      const saved = await t.stop();
      if (saved) {
        forgetFileUrl(saved.poster ?? '');
        // Ready for the next take: this one waits in the project.
        setFresh(saved.path);
        if (!showProjectRef.current) setNotice(`${saved.title} is saved in the project. Record another, or open the project to put them together.`);
      }
    } catch (error) {
      setNotice(`The take couldn’t be saved: ${cleanCaptureError(error)}`);
    } finally {
      setPhase('idle');
      window.focus();
    }
  }, [phase]);

  const mark = useCallback((kind: 'highlight' | 'retake') => {
    const t = take.current;
    if (!t) return;
    t.mark(kind);
    setMarkers(t.markerCount);
  }, []);

  // ---- live ----
  const goLive = useCallback(
    async (destination: string) => {
      if (!capture) throw new Error('Going live isn’t available here');
      await mixer.resume();
      setHeld((h) => (take.current ? { camera: h.camera || !!cam.stream, screen: h.screen || !!scr.stream } : { camera: !!cam.stream, screen: !!scr.stream }));
      const hasSound = !!mixer.micTrack || mixer.hasSystem;
      sender.current = await LiveSender.start(capture, destination, program, hasSound ? mixer.track : null, CANVAS[settings.aspect].height);
      setNotice(null);
      if (settings.recordWhileLive && phase === 'idle') {
        takeWithLive.current = true;
        void startTake();
      }
    },
    [capture, cam.stream, mixer, phase, program, scr.stream, settings.aspect, settings.recordWhileLive, startTake],
  );

  const endLive = useCallback(async () => {
    const s = sender.current;
    sender.current = null;
    await s?.stop();
    await capture?.streamStop().catch(() => {});
    if (takeWithLive.current) void stop();
  }, [capture, stop]);

  // The stream ended on its own (the connection, `din studio end-live`): stop sending.
  useEffect(() => {
    if (live || !sender.current) return;
    const s = sender.current;
    sender.current = null;
    void s.stop();
    if (takeWithLive.current) void stop();
  }, [live, stop]);

  // ---- asked from outside ----
  const handled = useRef<unknown>(null);
  const latest = useRef({ record, stop, mark, update, phase, live, settings });
  useEffect(() => {
    latest.current = { record, stop, mark, update, phase, live, settings };
  });
  const perform = useCallback((a: Action | null) => {
    if (!a || a.nonce === undefined || handled.current === a.nonce) return;
    handled.current = a.nonce;
    const l = latest.current;
    if (a.action === 'record') {
      const change: Partial<typeof l.settings> = {};
      if (a.scene) change.scene = a.scene;
      if (a.aspect) change.aspect = a.aspect;
      if (a.project && l.phase === 'idle') {
        change.project = a.project;
        target.current = a.project;
      }
      if (Object.keys(change).length) l.update(change);
      // Once the new setup's captures are up.
      setTimeout(() => latest.current.record(), a.scene || a.aspect ? 1200 : 0);
    } else if (a.action === 'stop') void l.stop();
    else if (a.action === 'mark') l.mark(a.kind ?? 'highlight');
    else if (a.action === 'project' && a.project && l.phase === 'idle') {
      // A project made from outside: takes go into it from now on.
      l.update({ project: a.project });
      target.current = a.project;
      setView(null);
      setShowProject(true);
    } else if (a.action === 'live' && !l.live) {
      if (a.destination) l.update({ destination: a.destination });
      setGoLiveOpen(true);
    }
  }, []);
  useEffect(() => perform(actionOf(windowLaunch(), wasReopened())), [perform]);
  useEffect(() => onLaunch((launch) => perform(actionOf(launch))), [perform]);

  // ---- the project ----
  const fail = useCallback((what: string) => (e: unknown) => setNotice(`${what}: ${cleanCaptureError(e)}`), []);
  const changeProject = useCallback(
    (path: string, change: ProjectChange) => capture?.updateProject(path, change).then(put, fail('Couldn’t change the project')),
    [capture, put, fail],
  );

  const selectProject = useCallback(
    (p: ProjectInfo) => {
      if (phase !== 'idle') return;
      setView(null);
      setFresh(null);
      setRenamingProject(false);
      if (!p.single) {
        update({ project: p.path });
        return;
      }
      // A take from before projects becomes a project of its own.
      void capture?.openProject(p.path).then((opened) => {
        put(opened);
        update({ project: opened.path });
      }, fail(`Couldn’t open ${p.title}`));
    },
    [capture, phase, put, update, fail],
  );

  const newProject = useCallback(async (): Promise<ProjectInfo | null> => {
    if (!capture || phase !== 'idle') return null;
    try {
      const made = await capture.createProject();
      put(made);
      update({ project: made.path });
      target.current = made.path;
      setView(null);
      setFresh(null);
      setShowProject(true);
      setRenamingProject(true);
      return made;
    } catch (e) {
      fail('Couldn’t make a project')(e);
      return null;
    }
  }, [capture, phase, put, update, fail]);

  /** Bring files in as clips, one after another, into the project (a new one if there's none). */
  const importClips = useCallback(
    async (files: FileSystemFileHandle[]) => {
      if (!capture || files.length === 0) return;
      let into = project && !project.single ? project.path : null;
      if (!into && project?.single) into = (await capture.openProject(project.path).catch(() => null))?.path ?? null;
      if (!into) into = (await newProject())?.path ?? null;
      if (!into) return;
      setShowProject(true);
      for (const handle of files) {
        setImporting((list) => [...list, handle.name]);
        let clip: string | null = null;
        try {
          const file = await handle.getFile();
          const begun = await capture.importBegin(into, file.name);
          clip = begun.take;
          const writer = await capture.open(begun.take, begun.file);
          try {
            for (let at = 0; at < file.size; at += CLIP_CHUNK) {
              await capture.write(writer, new Uint8Array(await file.slice(at, at + CLIP_CHUNK).arrayBuffer()));
            }
          } finally {
            await capture.close(writer);
          }
          const added = await capture.importEnd(begun.take);
          if (added) setFresh(added.path);
        } catch (e) {
          if (clip) void capture.importEnd(clip, true).catch(() => {});
          fail(`Couldn’t add ${handle.name}`)(e);
        } finally {
          setImporting((list) => {
            const i = list.indexOf(handle.name);
            return i === -1 ? list : [...list.slice(0, i), ...list.slice(i + 1)];
          });
        }
      }
    },
    [capture, project, newProject, fail],
  );

  const pickClips = useCallback(async () => {
    let files: FileSystemFileHandle[];
    try {
      files = await window.showOpenFilePicker({ title: 'Add Clips', confirmLabel: 'Add', multiple: true, mode: 'read', startIn: 'videos', types: CLIP_TYPES });
    } catch {
      return; // Cancelled.
    }
    await importClips(files);
  }, [importClips]);

  const reveal = (path: string) => void din.files.fromPath(path).then((h) => din.app.openFiles([h]));

  const moveItem = (name: string, to: number) => {
    if (!project) return;
    const order = project.items.map((i) => i.take.name).filter((n) => n !== name);
    order.splice(Math.max(0, Math.min(order.length, to)), 0, name);
    void changeProject(project.path, { order });
  };

  const changeItem = (item: ProjectItem, change: ItemChange) => {
    if (project) void changeProject(project.path, { item: { name: item.take.name, ...change } });
  };

  const itemAction = (item: ProjectItem, action: ItemAction) => {
    const index = project?.items.findIndex((i) => i.take.path === item.take.path) ?? -1;
    switch (action) {
      case 'open':
        if (phase === 'idle') setView({ kind: 'take', take: item.take.path });
        break;
      case 'keep':
        changeItem(item, { keep: !item.keep });
        break;
      case 'up':
        if (index > 0) moveItem(item.take.name, index - 1);
        break;
      case 'down':
        if (index !== -1) moveItem(item.take.name, index + 1);
        break;
      case 'reveal':
        reveal(item.take.path);
        break;
      case 'rename':
        setShowProject(true);
        setRenaming(item.take.path);
        break;
      case 'transcribe':
        void capture?.transcribe(item.take.path).catch(fail(`Couldn’t transcribe ${item.take.title}`));
        break;
      case 'trash':
        setTrashing({ item });
        break;
    }
  };

  const projectAction = (action: ProjectAction) => {
    if (!project) return;
    switch (action) {
      case 'assistant':
        if (phase === 'idle') setView({ kind: 'make', focus: Date.now() });
        break;
      case 'import':
        void pickClips();
        break;
      case 'rename':
        setShowProject(true);
        setRenamingProject(true);
        break;
      case 'reveal':
        reveal(project.path);
        break;
      case 'trash':
        setTrashing({ project });
        break;
    }
  };

  const renamed = (item: ProjectItem, title: string | null) => {
    setRenaming(null);
    if (title && title !== item.take.title) void capture?.rename(item.take.path, title).catch(fail('Couldn’t rename it'));
  };

  const projectRenamed = (title: string | null) => {
    setRenamingProject(false);
    if (project && title && title !== project.title) void changeProject(project.path, { title });
  };

  const trash = async (what: NonNullable<typeof trashing>) => {
    setTrashing(null);
    const path = 'item' in what ? what.item.take.path : what.project.path;
    const title = 'item' in what ? what.item.take.title : what.project.title;
    try {
      await din.system.fs?.trash(path);
      if ('project' in what) {
        put({ path, removed: true });
        if (settings.project === path) update({ project: '' });
        setView(null);
      } else {
        if (project) refresh(project.path);
        if (view?.kind === 'take' && view.take === path) setView(null);
      }
    } catch (e) {
      setNotice(`Couldn’t move ${title} to the Trash: ${cleanCaptureError(e)}`);
    }
  };

  // ---- menus ----
  const recording = phase === 'recording';
  const setScene = (scene: StudioScene) => update({ scene });
  const setAspect = (aspect: StudioAspect) => update({ aspect });
  useMenuBar(
    [
      {
        label: 'Project',
        items: [
          { id: 'new-project', label: 'New Project', accelerator: 'Ctrl+N', enabled: phase === 'idle' && !!capture },
          { id: 'import', label: 'Add Clips…', accelerator: 'Ctrl+I', enabled: !!capture },
          { type: 'separator' },
          { id: 'make', label: 'Make with Assistant…', enabled: !!project && phase === 'idle' && canAssist && project.items.some((i) => i.keep) },
          { id: 'reveal-project', label: 'Show in Files', enabled: !!project },
          { id: 'rename-project', label: 'Rename Project', enabled: !!project },
        ],
      },
      {
        label: 'Record',
        items: [
          recording
            ? { id: 'stop', label: 'Stop Recording', accelerator: 'Ctrl+R' }
            : { id: 'record', label: 'Start Recording', accelerator: 'Ctrl+R', enabled: phase === 'idle' && !!capture },
          { type: 'separator' },
          { id: 'mark', label: 'Mark Highlight', accelerator: 'Ctrl+M', enabled: recording },
          { id: 'retake', label: 'Mark Retake', accelerator: 'Ctrl+Backspace', enabled: recording, notInFields: true },
          { type: 'separator' },
          live
            ? { id: 'end-live', label: 'End Stream', destructive: true }
            : { id: 'go-live', label: 'Go Live…', enabled: !!status?.ffmpeg && phase !== 'countdown' && phase !== 'stopping' },
        ],
      },
      {
        label: 'View',
        items: [
          ...SCENES.map((s, i) => ({ id: `scene:${s.value}`, type: 'radio' as const, group: 'scene', checked: settings.scene === s.value, label: s.label, accelerator: `Ctrl+${i + 1}` })),
          { type: 'separator' },
          ...ASPECTS.map((a) => ({ id: `aspect:${a.value}`, type: 'radio' as const, group: 'aspect', checked: settings.aspect === a.value, label: a.label, enabled: !busy })),
          { type: 'separator' },
          { id: 'project', type: 'checkbox', checked: showProject, label: 'Project', accelerator: 'Ctrl+T' },
        ],
      },
    ],
    (id) => {
      if (id === 'record') record();
      else if (id === 'stop') void stop();
      else if (id === 'mark') mark('highlight');
      else if (id === 'retake') mark('retake');
      else if (id === 'go-live') setGoLiveOpen(true);
      else if (id === 'end-live') void endLive();
      else if (id === 'project') setShowProject((s) => !s);
      else if (id === 'new-project') void newProject();
      else if (id === 'import') void pickClips();
      else if (id === 'make') projectAction('assistant');
      else if (id === 'reveal-project') projectAction('reveal');
      else if (id === 'rename-project') projectAction('rename');
      else if (id.startsWith('scene:')) setScene(id.slice(6) as StudioScene);
      else if (id.startsWith('aspect:') && !busy) setAspect(id.slice(7) as StudioAspect);
    },
  );

  useEffect(() => {
    if (phase !== 'countdown') return;
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancelCountdown();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [phase, cancelCountdown]);

  useWindowTitle(
    recording && takeStart !== null ? `● ${formatTime(now - takeStart)}`
      : live?.phase === 'live' ? `LIVE ${formatTime(now - live.startedAt)}`
        : null,
  );

  // While recording, closing asks first: the take would be cut off.
  useCloseGuard(
    busy
      ? () => {
          setNotice(live ? 'End the stream before closing Studio.' : 'Stop recording before closing Studio.');
          return true;
        }
      : null,
  );

  // ---- what to show ----
  const openIndex = view?.kind === 'take' && project ? project.items.findIndex((i) => i.take.path === view.take) : -1;
  const openItem = openIndex === -1 ? null : project!.items[openIndex]!;
  const options = { canTranscribe: !!status?.transcribe, canAssist, recording: phase !== 'idle' };
  const bubbleShown = layout.scene === 'screen-camera' && layout.shape !== 'split' && !!cam.stream && !!scr.stream;
  const cameraControl = {
    on: settings.cameraOn,
    devices: devices.cameras,
    selected: settings.camera,
    error: cam.error,
    onToggle: () => update({ cameraOn: !settings.cameraOn }),
    onSelect: (camera: string) => update({ camera, cameraOn: true }),
  };
  const micControl = {
    on: settings.micOn,
    devices: devices.mics,
    selected: settings.mic,
    error: mic.error,
    onToggle: () => update({ micOn: !settings.micOn }),
    onSelect: (m: string) => update({ mic: m, micOn: true }),
  };
  const level = useCallback(() => mixer.level(), [mixer]);
  const elapsed = takeStart !== null ? now - takeStart : 0;

  let empty: React.ReactNode = null;
  if (!capture) {
    empty = <StageMessage title="Studio needs Din" body="Recording and going live work in Din’s desktop app." />;
  } else if (!cam.stream && !scr.stream) {
    const reason = (settings.scene !== 'screen' && cam.error) || (settings.scene !== 'camera' && scr.error);
    empty =
      settings.scene === 'camera' && !settings.cameraOn ? (
        <StageMessage title="The camera is off" body="Turn it on below, or choose Screen to record what’s on it." />
      ) : reason ? (
        <StageMessage title={reason} body="Check that it’s connected, or choose another one below." />
      ) : null;
  }

  return (
    <div className="@container/studio flex h-full flex-col bg-background text-foreground">
      <WindowDragRegion className="relative flex h-12 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        <div className="flex items-center gap-2 pl-1 text-sm font-semibold">
          <Clapperboard className="size-4 text-muted-foreground" aria-hidden />
          <span className="hidden @4xl/studio:inline">Studio</span>
        </div>
        <ProjectSwitcher projects={projects} current={project} disabled={phase !== 'idle'} onSelect={selectProject} onNew={() => void newProject()} />
        {/* What sets up the recording follows the name, as every app's title
            bar has what acts on its content at the left. */}
        <div className="ml-2 flex items-center gap-2">
          <div className="hidden @3xl/studio:block">
            <Segmented label="What to record" value={settings.scene} onChange={setScene} segments={SCENES} />
          </div>
          <div className="@3xl/studio:hidden">
            <Segmented label="What to record" value={settings.scene} onChange={setScene} segments={SCENES} iconOnly />
          </div>
          <Segmented label="Shape of the picture" value={settings.aspect} onChange={setAspect} segments={ASPECTS} disabled={busy} iconOnly />
          <button
            type="button"
            onClick={() => setShowProject((s) => !s)}
            aria-pressed={showProject}
            aria-label="Project"
            title="Project (Ctrl+T)"
            className={cn('grid size-8 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring', showProject && 'bg-accent text-foreground')}
          >
            <PanelRight className="size-4" />
          </button>
        </div>
        <div className="min-w-2 flex-1" />
        <WindowControls className="ml-2" />
      </WindowDragRegion>

      <div className="flex min-h-0 flex-1">
        <main className="relative flex min-w-0 flex-1 flex-col">
          {openItem && phase === 'idle' ? (
            <TakeView
              key={openItem.take.path}
              item={openItem}
              index={openIndex}
              count={project!.items.length}
              options={options}
              onBack={() => setView(null)}
              onAction={(a) => itemAction(openItem, a)}
              onChange={(change) => changeItem(openItem, change)}
            />
          ) : view?.kind === 'make' && project && phase === 'idle' ? (
            <MakeView project={project} focusComposer={view.focus} canAssist={canAssist} onBack={() => setView(null)} onRefresh={() => refresh(project.path)} />
          ) : (
            <div className="flex min-h-0 flex-1 flex-col bg-neutral-950">
              {(notice || live?.behind) && (
                <div role="status" className="mx-auto mt-3 flex max-w-xl items-start gap-3 rounded-xl bg-neutral-800 px-4 py-2.5 text-sm text-white shadow-lg">
                  <span className="flex-1">{notice ?? 'Your connection is falling behind the stream. Viewers may see it stutter.'}</span>
                  {notice && (
                    <button type="button" onClick={() => setNotice(null)} className="text-white/60 outline-none hover:text-white focus-visible:underline">
                      Dismiss
                    </button>
                  )}
                </div>
              )}
              {live && (
                <div className="absolute top-3 left-3 z-10 flex items-center gap-2 rounded-full bg-red-600 px-3 py-1 text-xs font-semibold text-white shadow-lg">
                  <span className="size-2 rounded-full bg-white motion-safe:animate-pulse" aria-hidden />
                  {live.phase === 'connecting' ? `Connecting to ${live.destination}…` : live.phase === 'ending' ? 'Ending…' : `LIVE · ${formatTime(now - live.startedAt)}`}
                  {live.phase === 'live' && live.bitrate !== null && <span className="font-normal text-white/80">{(live.bitrate / 1000).toFixed(1)} Mb/s</span>}
                </div>
              )}
              <Stage
                compositor={compositor}
                layout={layout}
                movable={bubbleShown}
                onBubble={(b: Bubble) => update({ bubbles: { ...settings.bubbles, [settings.aspect]: b } })}
                recording={recording}
                countdown={count}
                onCancelCountdown={cancelCountdown}
              >
                {empty}
              </Stage>
              <Controls
                phase={phase}
                elapsed={elapsed}
                markers={markers}
                camera={cameraControl}
                mic={micControl}
                micLevel={level}
                shape={settings.shape}
                onShape={(shape) => update({ shape })}
                mirror={settings.mirror}
                onMirror={(mirror) => update({ mirror })}
                computerSound={settings.computerSound}
                onComputerSound={(computerSound) => update({ computerSound })}
                computerSoundAvailable={!!status?.screen || !!monitor}
                countdown={settings.countdown}
                onCountdown={(countdown) => update({ countdown })}
                hideWhileRecording={settings.hideWhileRecording}
                onHideWhileRecording={(hideWhileRecording) => update({ hideWhileRecording })}
                canRecord={!!capture && (!!cam.stream || !!scr.stream || !!mic.stream)}
                onRecord={record}
                onStop={() => void stop()}
                onMark={mark}
                live={live}
                canGoLive={!!status?.ffmpeg}
                onGoLive={() => setGoLiveOpen(true)}
                onEndLive={() => void endLive()}
              />
            </div>
          )}
        </main>
        {showProject && (
          <ProjectPanel
            project={project}
            loading={loading}
            selected={view?.kind === 'take' ? view.take : null}
            fresh={fresh}
            renaming={renaming}
            renamingProject={renamingProject}
            options={options}
            importing={importing}
            onOpen={(item) => itemAction(item, 'open')}
            onItemAction={itemAction}
            onRenamed={renamed}
            onProjectAction={projectAction}
            onProjectRenamed={projectRenamed}
            onMove={moveItem}
            onImport={(files) => void importClips(files)}
            onPickClips={() => void pickClips()}
            onNewProject={() => void newProject()}
            onMake={() => projectAction('assistant')}
            onClose={() => setShowProject(false)}
          />
        )}
      </div>

      {capture && goLiveOpen && (
        <GoLiveDialog
          open
          onOpenChange={setGoLiveOpen}
          capture={capture}
          selected={settings.destination}
          onSelect={(destination) => update({ destination })}
          recordWhileLive={settings.recordWhileLive}
          onRecordWhileLive={(recordWhileLive) => update({ recordWhileLive })}
          recording={phase !== 'idle'}
          onGoLive={goLive}
        />
      )}

      <AlertDialog open={trashing !== null} onOpenChange={(open) => !open && setTrashing(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Move “{trashing && ('item' in trashing ? trashing.item.take.title : trashing.project.title)}” to the Trash?</AlertDialogTitle>
            <AlertDialogDescription>
              {trashing && 'project' in trashing
                ? 'The project’s folder goes to the Trash with every take and clip in it, and what the Assistant made from them.'
                : 'Its folder goes to the Trash with everything recorded in it. The rest of the project stays.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" onClick={() => trashing && void trash(trashing)}>
              Move to Trash
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** The most a capture of Din's frame needs to be for the display in it to fill the picture. */
function captureSize(display: CaptureRect): { width: number; height: number } {
  const longest = Math.max(...Object.values(CANVAS).map((c) => Math.max(c.width, c.height)));
  return {
    width: Math.min(7680, Math.round(longest / Math.max(display.width, 0.01))),
    height: Math.min(7680, Math.round(longest / Math.max(display.height, 0.01))),
  };
}

function StageMessage({ title, body }: { title: string; body: string }) {
  return (
    <div className="max-w-sm text-center text-white">
      <p className="text-lg font-medium">{title}</p>
      <p className="mt-1 text-sm text-white/65">{body}</p>
    </div>
  );
}
