/**
 * The sound Studio records and streams: the microphone, with the computer's
 * sound mixed in when it's on, as one track. The microphone on its own is
 * recorded too (mic track), for editing without the computer's sound.
 */
export class AudioMixer {
  private ctx = new AudioContext({ sampleRate: 48_000, latencyHint: 'interactive' });
  private dest = this.ctx.createMediaStreamDestination();
  private analyser = this.ctx.createAnalyser();
  private samples = new Float32Array(1024);
  private mic: { stream: MediaStream; node: MediaStreamAudioSourceNode } | null = null;
  private system: { stream: MediaStream; node: MediaStreamAudioSourceNode } | null = null;

  constructor() {
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.6;
  }

  /** The mix, for the program and the stream. */
  get track(): MediaStreamTrack {
    return this.dest.stream.getAudioTracks()[0];
  }

  /** The microphone alone, or null when it's off. */
  get micTrack(): MediaStreamTrack | null {
    return this.mic?.stream.getAudioTracks()[0] ?? null;
  }

  get hasSystem(): boolean {
    return this.system !== null;
  }

  /** Browsers start sound paused until a click; recording is one. */
  resume(): Promise<void> {
    return this.ctx.state === 'suspended' ? this.ctx.resume() : Promise.resolve();
  }

  setMic(stream: MediaStream | null): void {
    if (this.mic?.stream === stream) return;
    this.mic?.node.disconnect();
    this.mic = stream ? { stream, node: this.ctx.createMediaStreamSource(stream) } : null;
    if (this.mic) {
      this.mic.node.connect(this.dest);
      this.mic.node.connect(this.analyser);
    }
  }

  setSystem(stream: MediaStream | null): void {
    if (this.system?.stream === stream) return;
    this.system?.node.disconnect();
    this.system = stream ? { stream, node: this.ctx.createMediaStreamSource(stream) } : null;
    this.system?.node.connect(this.dest);
  }

  /** How loud the microphone is now, 0 to 1, for a meter. */
  level(): number {
    if (!this.mic) return 0;
    this.analyser.getFloatTimeDomainData(this.samples);
    let sum = 0;
    for (const s of this.samples) sum += s * s;
    const rms = Math.sqrt(sum / this.samples.length);
    // Speech sits around -30 to -10 dBFS: spread that across the meter.
    const db = 20 * Math.log10(Math.max(rms, 1e-5));
    return Math.min(1, Math.max(0, (db + 55) / 45));
  }

  dispose(): void {
    this.mic?.node.disconnect();
    this.system?.node.disconnect();
    void this.ctx.close();
  }
}
