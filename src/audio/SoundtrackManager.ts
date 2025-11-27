import * as Tone from 'tone';

class SoundtrackManager {
  private masterGain: Tone.Gain;
  private isInitialized: boolean = false;
  private isPlaying: boolean = false;

  constructor() {
    this.masterGain = new Tone.Gain(0.5).toDestination();
  }

  init() {
    if (this.isInitialized) return;

    Tone.Transport.bpm.value = 85;

    // --- Master Effects Chain ---
    const masterReverb = new Tone.Reverb({ decay: 4, wet: 0.3 }).connect(this.masterGain);
    const masterDelay = new Tone.PingPongDelay({
      delayTime: "8n",
      feedback: 0.2,
      wet: 0.2,
    }).connect(masterReverb);

    // --- Instrument 1: Metallic Bass ---
    const metallicBass = new Tone.FMSynth({
      harmonicity: 1.5,
      modulationIndex: 10,
      oscillator: { type: "sine" },
      modulation: { type: "sine" },
      envelope: { attack: 0.005, decay: 0.3, sustain: 1, release: 0.2 },
      modulationEnvelope: { attack: 0.001, decay: 0.2, sustain: 0, release: 0.1 },
      volume: -12,
    }).connect(masterReverb);

    // --- Instrument 2: Glassy/Bell Lead ---
    const glassLead = new Tone.PolySynth(Tone.FMSynth, {
      harmonicity: 3.01,
      modulationIndex: 3,
      oscillator: { type: "sine" },
      envelope: { attack: 0.01, decay: 0.2, sustain: 0, release: 1 },
      modulationEnvelope: { attack: 0.01, decay: 0.2, sustain: 0, release: 0.2 },
      volume: -10,
    }).connect(masterDelay);

    // --- Instrument 3: Tiny Metal Clicks ---
    const tingSynth = new Tone.MetalSynth({
      envelope: { attack: 0.001, decay: 0.05, release: 0.01 },
      harmonicity: 5.1,
      modulationIndex: 32,
      resonance: 4000,
      octaves: 1.5,
      volume: -30,
    }).connect(masterReverb);
    tingSynth.frequency.value = 200;

    // --- Sequencing ---
    // 1. Bass Loop
    new Tone.Sequence(
      (time, note) => {
        if (note) {
          metallicBass.triggerAttackRelease(note, "16n", time);
        }
      },
      [
        ["C2", null], "C2", [null, "G2"], null,
        ["F2", null], "F2", [null, "G1"], null,
      ],
      "4n"
    ).start(0);

    // 2. Melody Loop
    const melodyChords = [
      ["C5", "E5", "G5", "B5"],
      ["A4", "C5", "E5", "G5"],
      ["F4", "A4", "C5", "E5"],
      ["G4", "B4", "D5", "F5"],
    ];
    let chordIndex = 0;
    new Tone.Loop((time) => {
      const currentChord = melodyChords[chordIndex % melodyChords.length];
      glassLead.triggerAttackRelease(currentChord[0], "8n", time);
      glassLead.triggerAttackRelease(currentChord[1], "8n", time + 0.1);
      glassLead.triggerAttackRelease(currentChord[2], "8n", time + 0.2);
      glassLead.triggerAttackRelease(currentChord[3], "8n", time + 0.3);
      chordIndex++;
    }, "1m").start(0);

    // 3. Bubble Loop
    new Tone.Loop((time) => {
      if (Math.random() > 0.5) {
        tingSynth.triggerAttackRelease("32n", time + Math.random() * 0.5);
      }
    }, "4n").start(0);

    this.isInitialized = true;
  }

  async start() {
    if (!this.isInitialized) this.init();
    await Tone.start();
    Tone.Transport.start();
    this.isPlaying = true;
  }

  stop() {
    Tone.Transport.stop();
    this.isPlaying = false;
  }

  setVolume(volume: number) {
    // volume is 0-1.
    this.masterGain.gain.rampTo(volume, 0.1);
  }

  get isSoundtrackPlaying() {
    return this.isPlaying;
  }
}

export const soundtrackManager = new SoundtrackManager();
