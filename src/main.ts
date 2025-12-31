import localForage from 'localforage';
import i18next from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { MidiParser, MidiWriter, MidiConverter } from './midi';
import { filenameToName, dispatchPointerPressEvent, resetAnimation, multipleFloor, minmax } from './utils';

import en from './locales/en.json';
import ja from './locales/ja.json';

import './style.scss'

const STORAGE_KEY = 'AnySound-Seq-Lang' as const;

i18next
  .use(LanguageDetector)
  .init({
    fallbackLng: 'en',
    detection: {
      lookupCookie: STORAGE_KEY,
      lookupLocalStorage: STORAGE_KEY,
      lookupSessionStorage: STORAGE_KEY,
    },
    resources: {
      en: { translation: en },
      ja: { translation: ja },
    },
  }).then(() => {
    updateTranslations();
    setupLanguage();
  });

function updateTranslations() {
  (document.querySelectorAll('[data-i18n]') as NodeListOf<HTMLElement>).forEach(element => {
    const keys = element.dataset.i18n?.split(' ') || [];
    keys.forEach((key, index) => {
      if (key) {
        if (element.title) {
          element.title = i18next.t(key);
        } else if ((element as HTMLInputElement).placeholder && index === 0) {
          (element as HTMLInputElement).placeholder = i18next.t(key);
        } else if ((element as HTMLInputElement).value && index === 1) {
          (element as HTMLInputElement).value = i18next.t(key);
        } else {
          element.innerText = i18next.t(key);
        }
      }
    });
  });

  // Update drop messages
  (document.querySelectorAll('[data-i18n-drop]') as NodeListOf<HTMLElement>).forEach(element => {
    element.dataset.dropMessage = i18next.t('drop_sound_or_midi');
  });

  // Update document title
  document.title = i18next.t('title');
}

function setupLanguage() {
  const currentLang = i18next.language.slice(0, 2);

  document.documentElement.lang = currentLang;

  // Set active select option
  (document.getElementById('language-select') as HTMLSelectElement).value = currentLang;

  // Add event listeners
  document.getElementById('language-select')?.addEventListener('change', (event) => {
    const selectedLang = (event.target as HTMLSelectElement).value;
    changeLanguage(selectedLang);
  });
}

function changeLanguage(lang: string) {
  i18next.changeLanguage(lang).then(() => {
    updateTranslations();

    document.documentElement.lang = lang;

    // Update active select option
    (document.getElementById('language-select') as HTMLSelectElement).value = lang;

    // Save to localStorage
    localStorage.setItem(STORAGE_KEY, lang);
  });
}

// Types and Interfaces
interface Note {
  id: string;
  track: number; // melody track number
  pitch: number; // MIDI note number (0-127)
  start: number; // beat position
  length: number; // length in beats
  velocity: number; // 0-127
}

interface Beat {
  id: string;
  track: number; // rhythm track number
  position: number; // beat position
  velocity: number; // 0-127
}

interface AudioFile {
  file: File;
  pitchShift: number; // for melody tracks
}

interface Filenames {
  melody: Map<number, string>; // track -> filename
  beat1: string | null;
  beat2: string | null;
}

interface InstrumentCodes {
  [key: number]: number;
}

interface AudioSample {
  buffer: AudioBuffer | null;
  type: 'sine' | 'file';
}

// Audio Manager Class
class AudioManager {
  private context: AudioContext;
  private masterGain: GainNode;
  private melodySamples: Map<string, Map<number, AudioSample>> = new Map();
  private melodyPitchShifts: Map<string, number> = new Map();
  private beatSamples: Map<number, AudioSample> = new Map();
  private previewSources: Map<string, { source: AudioBufferSourceNode; gain: GainNode }> = new Map();

  constructor() {
    this.context = new AudioContext();
    this.masterGain = this.context.createGain();
    this.masterGain.connect(this.context.destination);
    this.masterGain.gain.value = 0.7;

    // Initialize with sine waves
    this.initializeSineWaves();
  }

  private initializeSineWaves() {
    // Initialize melody sine waves for MIDI notes 21-108 (A0-C8)
    this.melodySamples.set('sine', new Map());
    for (let note = 21; note <= 108; note++) {
      this.melodySamples.get('sine')?.set(note, { buffer: null, type: 'sine' });
    }

    // Initialize beat sine waves
    this.beatSamples.set(0, { buffer: null, type: 'sine' }); // Beat 1
    this.beatSamples.set(1, { buffer: null, type: 'sine' }); // Beat 2
  }

  private createSineWave(frequency: number, duration: number = 1): AudioBuffer {
    const sampleRate = this.context.sampleRate;
    const length = sampleRate * duration;
    const buffer = this.context.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);

    for (let i = 0; i < length; i++) {
      data[i] = Math.sin(2 * Math.PI * frequency * i / sampleRate) * Math.exp(-i / (sampleRate * duration)); // Damped sine wave
    }

    return buffer;
  }

  private midiToFrequency(midiNote: number): number {
    return 440 * Math.pow(2, (midiNote - 69) / 12);
  }

  private midiToPercentage(midiNote: number, pitchShift: number = 0): number {
    return Math.pow(2, (midiNote - 60 + pitchShift) / 12); // C4 as reference
  }

  async loadFile(file: File): Promise<AudioBuffer> {
    const arrayBuffer = await file.arrayBuffer();
    return this.context.decodeAudioData(arrayBuffer);
  }

  async setMelodyAudio(file: File | null) {
    if (!file) return;
    const filename = file.name;
    this.melodySamples.set(filename, new Map());
    return this.loadFile(file).then(buffer => {
      for (let note = 21; note <= 108; note++) {
        this.melodySamples.get(filename)?.set(note, { buffer, type: 'file' });
      }
    });
  }

  deleteMelodyAudio(filename: string) {
    this.melodySamples.delete(filename);
    this.melodyPitchShifts.delete(filename);
  }

  setMelodyPitchShift(filename: string, pitchShift: number) {
    this.melodyPitchShifts.set(filename, pitchShift);
  }

  async setBeatSample(track: number, file: File | null) {
    if (file) {
      return this.loadFile(file).then(buffer => {
        this.beatSamples.set(track, { buffer, type: 'file' });
      });
    } else {
      // Reset to sine wave
      this.beatSamples.set(track, { buffer: null, type: 'sine' });
      return Promise.resolve();
    }
  }
  
  stopPreview(previewId: string) {
    const preview = this.previewSources.get(previewId);
    if (preview) {
      try {
        // フェードアウトしてから停止
        preview.gain.gain.setValueAtTime(preview.gain.gain.value, this.context.currentTime);
        preview.gain.gain.linearRampToValueAtTime(0, this.context.currentTime + 0.05);
        preview.source.stop(this.context.currentTime + 0.05);
      } catch (e) {
        // すでに停止している場合のエラーを無視
      }
      this.previewSources.delete(previewId);
    }
  }

  // すべてのプレビュー音を停止
  stopAllPreviews() {
    this.previewSources.forEach((_, id) => {
      this.stopPreview(id);
    });
  }

  playNote(note: Note, filename: string, bpm: number, when: number = 0) {
    const sample = this.melodySamples.get(filename)?.get(note.pitch);
    if (!sample) return;

    const source = this.context.createBufferSource();
    const gain = this.context.createGain();

    const durationInSeconds = this.beatsToSeconds(note.length, bpm);

    if (sample.type === 'sine') {
      const frequency = this.midiToFrequency(note.pitch);
      source.buffer = this.createSineWave(frequency, durationInSeconds);
    } else {
      source.buffer = sample.buffer;
      source.playbackRate.value = this.midiToPercentage(note.pitch, this.melodyPitchShifts.get(filename) || 0);
    }

    gain.gain.value = (note.velocity / 127) * 0.5;

    source.connect(gain);
    gain.connect(this.masterGain);

    const startTime = this.context.currentTime + when;
    source.start(startTime);

    if (sample.type === 'file') {
      source.stop(startTime + durationInSeconds);
    }
  }

  // プレビュー音を再生（前の音は自動停止）
  playNotePreview(note: Note, filename: string, bpm: number, previewId: string, when: number = 0) {
    // 前のプレビュー音を停止
    this.stopPreview(previewId);

    const sample = this.melodySamples.get(filename)?.get(note.pitch);
    if (!sample) return;

    const source = this.context.createBufferSource();
    const gain = this.context.createGain();

    const durationInSeconds = this.beatsToSeconds(note.length, bpm);

    if (sample.type === 'sine') {
      const frequency = this.midiToFrequency(note.pitch);
      source.buffer = this.createSineWave(frequency, durationInSeconds);
    } else {
      source.buffer = sample.buffer;
      source.playbackRate.value = this.midiToPercentage(note.pitch, this.melodyPitchShifts.get(filename) || 0);
    }

    // フェードインで開始
    gain.gain.setValueAtTime(0, this.context.currentTime + when);
    gain.gain.linearRampToValueAtTime((note.velocity / 127) * 0.3, this.context.currentTime + when + 0.02);

    source.connect(gain);
    gain.connect(this.masterGain);

    const startTime = this.context.currentTime + when;
    source.start(startTime);

    // プレビュー音源を管理マップに追加
    this.previewSources.set(previewId, { source, gain });

    return previewId;
  }
  
  private beatsToSeconds(beats: number, bpm: number): number {
    return (60 / bpm) * beats;
  }

  playBeat(beat: Beat, when: number = 0) {
    const sample = this.beatSamples.get(beat.track);
    if (!sample) return;

    const source = this.context.createBufferSource();
    const gain = this.context.createGain();

    if (sample.type === 'sine') {
      const frequency = beat.track === 0 ? 200 : 150; // Different frequencies for different beats
      source.buffer = this.createSineWave(frequency, 0.2);
    } else {
      source.buffer = sample.buffer;
    }

    gain.gain.value = (beat.velocity / 127) * 0.7;

    source.connect(gain);
    gain.connect(this.masterGain);

    const startTime = this.context.currentTime + when;
    source.start(startTime);
    source.stop(startTime + 0.2);
  }

  async resume() {
    if (this.context.state === 'suspended') {
      await this.context.resume();
    }
  }

  async renderMixToAudioBuffer(params: {
    notes: Note[];
    beats: Beat[];
    filenames: Filenames;
    files: AudioFile[];
    bpm: number;
    bpms: Map<number, number>; // beat position -> bpm
    playbackSpeed: number;
    duration: number;
    sampleRate?: number;
    numChannels?: number;
  }, onProgress?: (processedSamples: number, totalSamples: number) => void): Promise<AudioBuffer> {
    const sampleRate = params.sampleRate || 44100;
    const numChannels = params.numChannels || 2;
    const masterGain = 0.7;

    const totalSamples = Math.ceil(params.duration * sampleRate);

    // Prepare output buffers
    const outputs: Float32Array[] = [];
    for (let ch = 0; ch < numChannels; ch++) outputs.push(new Float32Array(totalSamples));

    // Convert a beat position to seconds, taking into account tempo changes in params.bpms
    const bpmEntries = ((): Array<{ beat: number; bpm: number }> => {
      const entries: Array<{ beat: number; bpm: number }> = [];
      // Ensure there's an initial entry at beat 0
      entries.push({ beat: 0, bpm: params.bpm });
      if (params.bpms && params.bpms.size) {
        Array.from(params.bpms.entries()).forEach(([beat, bpm]) => {
          if (beat === 0) {
            entries[0].bpm = bpm;
          } else {
            entries.push({ beat, bpm });
          }
        });
      }
      entries.sort((a, b) => a.beat - b.beat);
      return entries;
    })();

    const beatPosToSeconds = (beatPos: number): number => {
      if (beatPos <= 0) return 0;
      let seconds = 0;
      for (let i = 0; i < bpmEntries.length; i++) {
        const segStart = bpmEntries[i].beat;
        const segBpm = bpmEntries[i].bpm;
        const segEnd = i + 1 < bpmEntries.length ? bpmEntries[i + 1].beat : Infinity;
        if (beatPos <= segStart) break;
        const endBeat = Math.min(beatPos, segEnd);
        const deltaBeats = endBeat - segStart;
        seconds += (60 / (segBpm * params.playbackSpeed)) * deltaBeats;
        if (beatPos <= segEnd) break;
      }
      return seconds;
    };

    const beatRangeToSeconds = (startBeat: number, lengthBeats: number) => {
      const startSec = beatPosToSeconds(startBeat);
      const endSec = beatPosToSeconds(startBeat + lengthBeats);
      return Math.max(0, endSec - startSec);
    };

    type NoteInfo = {
      note: Note;
      startSample: number;
      endSample: number;
      isSine: boolean;
      frequency?: number;
      durationSec?: number;
      sourceData?: Float32Array[];
      sourceSampleRate?: number;
      playbackRate?: number;
      gain: number;
    };

    const noteInfos: NoteInfo[] = [];

    params.notes.forEach(note => {
      const filename = params.filenames.melody.get(note.track) || 'sine';
      const sample = this.melodySamples.get(filename)?.get(note.pitch);
      if (!sample) return;
      const startSec = beatPosToSeconds(note.start);
      const durationSec = beatRangeToSeconds(note.start, note.length);
      const startSample = Math.floor(startSec * sampleRate);
      const endSample = Math.min(totalSamples, startSample + Math.ceil(durationSec * sampleRate));
      const gain = masterGain * (note.velocity / 127) * 0.5;

      if (sample.type === 'file' && sample.buffer instanceof AudioBuffer) {
        const srcBuf = sample.buffer;
        const srcChannels: Float32Array[] = [];
        for (let c = 0; c < srcBuf.numberOfChannels; c++) srcChannels.push(srcBuf.getChannelData(c));
        const playbackRate = this.midiToPercentage(note.pitch, this.melodyPitchShifts.get(filename) || 0);
        noteInfos.push({ note, startSample, endSample, isSine: false, sourceData: srcChannels, sourceSampleRate: srcBuf.sampleRate, playbackRate, gain });
      } else {
        noteInfos.push({ note, startSample, endSample, isSine: true, frequency: this.midiToFrequency(note.pitch), durationSec, gain });
      }
    });

    type BeatInfo = {
      beat: Beat;
      startSample: number;
      endSample: number;
      isSine: boolean;
      frequency?: number;
      sourceData?: Float32Array[];
      sourceSampleRate?: number;
      gain: number;
    };

    const beatInfos: BeatInfo[] = [];
    params.beats.forEach(beat => {
      const sample = this.beatSamples.get(beat.track);
      if (!sample) return;
      const startSec = beatPosToSeconds(beat.position);
      const durationSec = 0.2;
      const startSample = Math.floor(startSec * sampleRate);
      const endSample = Math.min(totalSamples, startSample + Math.ceil(durationSec * sampleRate));
      const gain = masterGain * (beat.velocity / 127) * 0.7;

      if (sample.type === 'file' && sample.buffer instanceof AudioBuffer) {
        const srcBuf = sample.buffer;
        const srcChannels: Float32Array[] = [];
        for (let c = 0; c < srcBuf.numberOfChannels; c++) srcChannels.push(srcBuf.getChannelData(c));
        beatInfos.push({ beat, startSample, endSample, isSine: false, sourceData: srcChannels, sourceSampleRate: srcBuf.sampleRate, gain });
      } else {
        const frequency = beat.track === 0 ? 200 : 150;
        beatInfos.push({ beat, startSample, endSample, isSine: true, frequency, gain });
      }
    });

    const blockSize = 16384;
    for (let blockStart = 0; blockStart < totalSamples; blockStart += blockSize) {
      const blockEnd = Math.min(totalSamples, blockStart + blockSize);

      // Process notes intersecting this block
      for (const ni of noteInfos) {
        if (ni.endSample <= blockStart || ni.startSample >= blockEnd) continue;
        const sStart = Math.max(blockStart, ni.startSample);
        const sEnd = Math.min(blockEnd, ni.endSample);

        if (ni.isSine) {
          const freq = ni.frequency!;
          const dur = ni.durationSec || ((ni.endSample - ni.startSample) / sampleRate);
          for (let i = sStart; i < sEnd; i++) {
            const t = (i - ni.startSample) / sampleRate;
            const val = Math.sin(2 * Math.PI * freq * t) * Math.exp(-t / Math.max(0.001, dur));
            for (let ch = 0; ch < numChannels; ch++) outputs[ch][i] += val * ni.gain;
          }
        } else {
          const srcRate = ni.sourceSampleRate || sampleRate;
          const playbackRate = ni.playbackRate || 1;
          const srcLen = ni.sourceData![0].length;
          for (let i = sStart; i < sEnd; i++) {
            const timeSinceStart = (i - ni.startSample) / sampleRate;
            const srcIndex = timeSinceStart * playbackRate * srcRate;
            if (srcIndex < 0 || srcIndex >= srcLen) continue;
            const idx0 = Math.floor(srcIndex);
            const frac = srcIndex - idx0;
            for (let ch = 0; ch < numChannels; ch++) {
              const srcCh = ni.sourceData![Math.min(ch, ni.sourceData!.length - 1)];
              const s0 = srcCh[idx0] || 0;
              const s1 = srcCh[idx0 + 1] || 0;
              const val = s0 * (1 - frac) + s1 * frac;
              outputs[ch][i] += val * ni.gain;
            }
          }
        }
      }

      // Process beats in this block
      for (const bi of beatInfos) {
        if (bi.endSample <= blockStart || bi.startSample >= blockEnd) continue;
        const sStart = Math.max(blockStart, bi.startSample);
        const sEnd = Math.min(blockEnd, bi.endSample);

        if (bi.isSine) {
          const freq = bi.frequency!;
          const dur = (bi.endSample - bi.startSample) / sampleRate;
          for (let i = sStart; i < sEnd; i++) {
            const t = (i - bi.startSample) / sampleRate;
            const val = Math.sin(2 * Math.PI * freq * t) * Math.exp(-t / Math.max(0.001, dur));
            for (let ch = 0; ch < numChannels; ch++) outputs[ch][i] += val * bi.gain;
          }
        } else {
          const srcRate = bi.sourceSampleRate || sampleRate;
          const srcLen = bi.sourceData![0].length;
          for (let i = sStart; i < sEnd; i++) {
            const timeSinceStart = (i - bi.startSample) / sampleRate;
            const srcIndex = timeSinceStart * srcRate;
            if (srcIndex < 0 || srcIndex >= srcLen) continue;
            const idx0 = Math.floor(srcIndex);
            const frac = srcIndex - idx0;
            for (let ch = 0; ch < numChannels; ch++) {
              const srcCh = bi.sourceData![Math.min(ch, bi.sourceData!.length - 1)];
              const s0 = srcCh[idx0] || 0;
              const s1 = srcCh[idx0 + 1] || 0;
              const val = s0 * (1 - frac) + s1 * frac;
              outputs[ch][i] += val * bi.gain;
            }
          }
        }
      }

      // Notify progress
      if (onProgress) onProgress(Math.min(blockEnd, totalSamples), totalSamples);

      // yield to event loop to keep UI responsive
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    // Create AudioBuffer and copy outputs
    const audioBuffer = new AudioBuffer({ length: totalSamples, numberOfChannels: numChannels, sampleRate });
    for (let ch = 0; ch < numChannels; ch++) {
      audioBuffer.getChannelData(ch).set(outputs[ch]);
    }
    return audioBuffer;
  }
}

// Sequencer Class
class Sequencer {
  private static readonly noteWidth = 40; // pixels per beat
  private static readonly noteHeight = 20; // pixels per note
  private audioManager: AudioManager;
  private viewPort: {
    startBeat: number | null;
    endBeat: number | null;
    startPitch: number | null;
    endPitch: number | null;
  } = {
    startBeat: null,
    endBeat: null,
    startPitch: null,
    endPitch: null
  }
  private title: string = '';
  private notes: Note[] = [];
  private beats: Beat[] = [];
  private files: AudioFile[] = [];
  private filenames: Filenames = {
    melody: new Map(),
    beat1: null,
    beat2: null
  };
  private instrumentCodes: InstrumentCodes = {};
  private currentTrack: number = 0;
  private bpm: number = 120;
  private bpms: Map<number, number> = new Map(); // beat position -> bpm
  private playbackSpeed: number = 1; // 0.5x, 1x, 2x
  private quantization: number = 0.5; // in beats
  private defaultNoteLength: number = 1;
  private paused: boolean = true;
  private ended: boolean = true;
  private gridSize: number = 64; // 64 beats
  private visibleNoteElements: Map<string, HTMLElement> = new Map(); // noteId -> element
  private saveTimeout: number | null = null;
  private bpmChanged: { time: number; beat: number; } = {
    time: 0,
    beat: 0
  };
  private currentBeat: number = 0;
  private playedNotes: Set<string> = new Set();
  private pointerDowned: boolean = false;
  private autoScroll: boolean = true;
  private selectedNotes: Set<string> = new Set();
  private isRectangleSelecting: boolean = false;
  private selectionStartX: number = 0;
  private selectionStartY: number = 0;
  private multiTouched: boolean = false; // true when 2+ touch points are active

  constructor() {
    this.audioManager = new AudioManager();

    this.setupEventListeners();
    this.setupDragAndDrop();
    this.initializePianoRoll();
    this.initializeRhythmSection();
    this.setupNoteDragResize();
    this.setupTrackScrolling();
    this.updateViewPort();
    this.setupLocalForage();
  }

  private setupEventListeners() {
    document.getElementById('title-input')?.addEventListener('input', (e) => {
      this.title = (e.target as HTMLInputElement).value.trim();
    });

    // Playback controls
    document.getElementById('prev-btn')?.addEventListener('click', () => {
      this.resetPlayback();
    });

    document.getElementById('play-btn')?.addEventListener('click', () => {
      if (this.paused) {
        this.play();
      } else {
        this.pause();
      }
    });

    document.addEventListener('pointerdown', (e) => {
      if (!e.isPrimary || e.button !== 0) return;
      window.clearTimeout(this.saveTimeout!);
    });

    document.addEventListener('pointerup', (e) => {
      if (!e.isPrimary || e.button !== 0) return; // 左クリックのみ
      this.saveTimeout = window.setTimeout(() => this.saveData(), 1000);
    });

    const sequencerContainer = document.querySelector('.sequencer-container') as HTMLElement;
    sequencerContainer.addEventListener('touchmove', (e) => {
      if (!this.multiTouched) { // 1本目の指は無視
        e.preventDefault();
      }
    }, { passive: false });

    // BPM control
    const bpmSlider = document.getElementById('bpm-slider') as HTMLInputElement;
    const bpmValue = document.getElementById('bpm-value') as HTMLInputElement;
    [bpmSlider, bpmValue].forEach(element => {
      element.addEventListener('input', (e) => {
        const input = e.target as HTMLInputElement;
        if (!input.value) {
          return;
        }
        const newBpm = minmax(input.valueAsNumber, input.min ? parseInt(input.min) : 60, input.max ? parseInt(input.max) : 300);

        // 再生中の場合、現在のビート位置を記録してからBPMを変更
        if (!this.paused) {
          this.recordBpmChanged();
        }
        this.bpm = newBpm;

        if (element === bpmSlider) {
          if (bpmValue) bpmValue.valueAsNumber = newBpm;
        } else {
          if (bpmSlider) bpmSlider.valueAsNumber = newBpm;
        }
      });
      element.addEventListener('change', (e) => {
        const input = e.target as HTMLInputElement;
        if (!input.value || !input.checkValidity()) {
          input.valueAsNumber = this.bpm;
          return;
        }
      });
    });

    const menu = document.querySelector('.menu') as HTMLElement;
    const menuBtn = document.querySelector('.menu-btn') as HTMLButtonElement;
    const menuContent = document.querySelector('.menu-content') as HTMLElement;
    menuBtn.addEventListener('click', () => {
      menu.classList.toggle('is-open');
    });
    document.addEventListener('click', (e) => {
      if (menuContent.contains(e.target as Node) && (e.target as Element).tagName === 'BUTTON'
        || !menuContent.contains(e.target as Node) && e.target !== menuBtn) {
        menu.classList.remove('is-open');
      }
    });
    const speedSelect = document.getElementById('speed-select') as HTMLSelectElement;
    speedSelect?.addEventListener('change', (e) => {
      const newPlaybackSpeed = parseFloat((e.target as HTMLSelectElement).value);
      
      // 再生中の場合、現在のビート位置を記録してから再生速度を変更
      if (!this.paused) {
        this.recordBpmChanged();
      }
      this.playbackSpeed = newPlaybackSpeed;
    });
    const quantizationSelect = document.getElementById('quantization-select') as HTMLSelectElement;
    quantizationSelect?.addEventListener('change', (e) => {
      const newQuantization = parseFloat((e.target as HTMLSelectElement).value);
      this.quantization = newQuantization;
      document.querySelectorAll('.beat').forEach(beat => beat.remove());
      this.createBeats();
      this.beats.forEach(beat => this.renderBeat(beat));
    });

    // Audio file inputs
    const soundButtonsContainers = document.querySelectorAll('.sound');
    soundButtonsContainers.forEach(container => {
      const track = (container as HTMLElement).dataset.track!;
      const soundSelectLabel = container.querySelector('.sound-select-label') as HTMLElement;
      const soundSelect = container.querySelector('.sound-select') as HTMLSelectElement;
      const removeSoundBtn = container.querySelector('.remove-sound') as HTMLButtonElement;
      const addSoundBtn = container.querySelector('.add-sound') as HTMLButtonElement;
      const selectAudioFiles = () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.wav,.mp3,.ogg,.flac,.aac,.m4a';
        input.multiple = true;
        const promise = new Promise<FileList | null>((resolve) => {
          input.onchange = (event) => {
            const files = (event.target as HTMLInputElement).files || null;
            if (!files || files.length === 0) {
              resolve(null);
            }
            resolve(files);
          };
          input.oncancel = () => {
            resolve(null);
          };
        });
        input.click();
        return promise;
      };
      const soundPreview = (filename: string) => {
        const noteId = `preview-sound-select-${Date.now()}`
        const note: Note = {
          id: noteId,
          track: this.currentTrack,
          pitch: 60, // C4
          start: 0,
          length: this.defaultNoteLength,
          velocity: 100
        };
        this.audioManager.playNotePreview(note, filename, this.bpm * this.playbackSpeed, noteId);
      };
      soundSelect.addEventListener('change', async (e) => {
        const value = (e.target as HTMLSelectElement).value;
        if (value === 'sine') {
          // 正弦波を選択
          await this.setSine(track);
          if (this.paused) soundPreview('sine');
        } else {
          // 既存の音源ファイルを選択
          const filename = value;
          const file = this.files.find(f => f.file.name === filename)?.file || null;
          await this.setAudio(track, file);
          if (this.paused) soundPreview(filename);
        }
      });

      removeSoundBtn.addEventListener('click', async () => {
        const filename = soundSelect.value;
        if (filename === 'sine') return;
        if (filename && confirm(i18next.t('confirm_remove_sound_file', { filename: filenameToName(filename) }))) {
          this.removeAudioFile(filename);
        }
      });

      addSoundBtn.addEventListener('click', async () => {
        selectAudioFiles().then(async files => {
          if (!files || files.length === 0) {
            // キャンセルされた場合は選択を戻す
            if (track === 'melody') {
              soundSelect.value = this.filenames.melody.get(this.currentTrack) || 'sine';
            } else if (track === 'beat1') {
              soundSelect.value = this.filenames.beat1 || 'sine';
            } else if (track === 'beat2') {
              soundSelect.value = this.filenames.beat2 || 'sine';
            }
            if (soundSelect.value !== 'sine') {
              soundSelectLabel.classList.add('added-sound');
            }
            return;
          }
          const isAudio = Array.from(files).every(file => file.type.startsWith('audio/'));
          if (!isAudio) {
            alert(i18next.t('error_not_audio_file'));
            return;
          }
          [...files].forEach(file => {
            const pitchShift = this.extractPitchShiftFromFilename(file.name);
            this.addAudioFile(file, pitchShift);
          });
          const file = files[0];
          await this.setAudio(track, file);
          if (this.paused) soundPreview(file.name);
        });
      });
    });

    let currentPreviewId: string | null = null;
    document.getElementById('melody-pitch-shift')?.addEventListener('input', (e) => {
      const filename = this.filenames.melody.get(this.currentTrack) || 'sine';
      const audioFile = this.files.find(f => f.file.name === filename) || null;
      const pitchShift = (e.target as HTMLInputElement).valueAsNumber || 0;
      if (audioFile) {
        audioFile.pitchShift = pitchShift;
      }
      this.audioManager.setMelodyPitchShift(filename, pitchShift);

      if (!this.paused) return;

      if (currentPreviewId) {
        this.audioManager.stopPreview(currentPreviewId);
      }

      currentPreviewId = `preview-pitch-shift-${Date.now()}`;
      const note: Note = {
        id: currentPreviewId,
        track: this.currentTrack,
        pitch: 60, // C4にピッチシフトが反映される
        start: 0,
        length: this.defaultNoteLength,
        velocity: 100
      };
      this.audioManager.playNotePreview(note, filename, this.bpm * this.playbackSpeed, currentPreviewId);
    });

    const rolls = document.querySelector('.rolls') as HTMLElement;
    document.getElementById('app')!.style.setProperty('--scrollbar-width', `${rolls.offsetHeight - rolls.clientHeight}px`);
    rolls.scrollTop = Sequencer.noteHeight * (12 * 2 + 2); // 2 octaves + extra space
    let beforeScrollLeft = 0, beforeScrollTop = rolls.scrollTop;
    rolls.addEventListener('pointerdown', () => {
      this.pointerDowned = true;
    });
    rolls.addEventListener('pointerup', (e) => {
      if (!e.isPrimary || e.button !== 0) return;
      this.pointerDowned = false;
    });
    rolls.addEventListener('scroll', (e) => {
      if (this.pointerDowned) {
        this.autoScroll = false;
      }
      const target = e.target as HTMLElement;
      const scrollLeft = target.scrollLeft;
      const scrollTop = target.scrollTop;
      if (Math.abs(scrollLeft - beforeScrollLeft) > Sequencer.noteWidth || Math.abs(scrollTop - beforeScrollTop) > Sequencer.noteHeight) {
        beforeScrollLeft = scrollLeft;
        beforeScrollTop = scrollTop;
        this.renderTracks();
      }
    });

    const playbackPosition = document.querySelector('.playback-position') as HTMLElement;
    let playbackDragging = false;
    let beforePos = 0;
    let initialRelativeX = 0;
    let beforePaused = true;

    playbackPosition.addEventListener('pointerenter', () => {
      playbackPosition.classList.add('hover');
    });

    playbackPosition.addEventListener('pointerleave', () => {
      if (playbackDragging) return;
      playbackPosition.classList.remove('hover');
    });
    
    const pianoRollSection = document.querySelector('.piano-roll-section') as HTMLElement;
    // マルチタッチ検知: 2本以上で有効にして、以降のポインター操作でノート追加を無視する
    (['touchstart', 'touchmove', 'touchend'] as (keyof HTMLElementEventMap)[]).forEach(eventName => {
      pianoRollSection.addEventListener(eventName, (e) => {
        const touchEvent = e as TouchEvent;
        if (touchEvent.touches.length >= 2) {
          this.multiTouched = true;
        }
      }, { passive: true });
    });
    pianoRollSection.addEventListener('touchend', (e) => {
      const touchEvent = e as TouchEvent;
      if (touchEvent.touches.length === 0) {
        this.multiTouched = false;
      }
    });

    playbackPosition.addEventListener('pointerdown', (e) => {
      if (!e.isPrimary || e.button !== 0) return; // 左クリックのみ
      beforePaused = this.paused;
      if (!this.paused) this.pause();
      playbackDragging = true;
      
      const pianoRollRect = pianoRollSection.getBoundingClientRect();
      initialRelativeX = e.clientX - pianoRollRect.left; // pianoRoll内での相対X座標
      beforePos = parseFloat(playbackPosition.style.getPropertyValue('--position')) || 0;
      rolls.classList.add('playback-drag');
    });

    [playbackPosition, rolls].forEach(element => {
      element.addEventListener('pointermove', (e) => {
        if (!playbackDragging) return;
        
        const pianoRollRect = pianoRollSection.getBoundingClientRect();
        const currentRelativeX = e.clientX - pianoRollRect.left;
        const deltaX = currentRelativeX - initialRelativeX;
        
        const newPosition = minmax(beforePos + deltaX, 0, this.gridSize * Sequencer.noteWidth);
        playbackPosition.style.setProperty('--position', `${newPosition}px`);
        const newBeat = newPosition / Sequencer.noteWidth;
        this.currentBeat = newBeat;
        
        this.playNotes(this.currentBeat);

        this.scrollByDragging(e, true);
      });
    });
    document.addEventListener('pointerup', (e) => {
      if (!playbackDragging || !e.isPrimary || e.button !== 0) return;
      if (!beforePaused) this.play();
      playbackDragging = false;
      playbackPosition.classList.remove('hover');
      rolls.classList.remove('playback-drag');
    });

    document.getElementById('clear-sounds-btn')?.addEventListener('click', () => {
      if (confirm(i18next.t('confirm_clear_sounds'))) {
        this.clearSounds();
        this.saveData();
      }
    });

    document.getElementById('clear-all-btn')?.addEventListener('click', () => {
      if (confirm(i18next.t('confirm_clear_all'))) {
        this.clearAll();
        this.saveData();
      }
    });

    // MIDI import/export
    document.getElementById('import-midi-btn')?.addEventListener('click', () => {
      this.importMidi();
    });

    document.getElementById('export-midi-btn')?.addEventListener('click', () => {
      this.exportMidi();
    });

    document.getElementById('export-wav-btn')?.addEventListener('click', async () => {
      await this.exportWav();
    });

    if ('mediaSession' in navigator) {
      navigator.mediaSession.setActionHandler('play', () => {
        this.play();
      });

      navigator.mediaSession.setActionHandler('pause', () => {
        this.pause();
      });

      navigator.mediaSession.setActionHandler('stop', () => {
        this.stop();
      });
    }
  }

  private setupDragAndDrop() {
    // Prevent default drag behaviors on the entire document
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
      document.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
      }, false);
    });

    // Handle drag events for all drop zones
    const dropZones = document.querySelectorAll('.drop-zone') as NodeListOf<HTMLElement>;
    
    dropZones.forEach(dropZone => {
      dropZone.addEventListener('dragenter', (e) => {
        e.preventDefault();
        dropZone.classList.add('drag-over');
      });

      dropZone.addEventListener('dragleave', (e) => {
        e.preventDefault();
        // Only remove drag-over if we're leaving the drop zone entirely
        if (!dropZone.contains(e.relatedTarget as Node)) {
          dropZone.classList.remove('drag-over');
        }
      });

      dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer!.dropEffect = 'copy';
      });

      dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('drag-over');
        
        const files = e.dataTransfer!.files;
        if (files.length === 0) return;

        this.handleFilesDrop(files, dropZone);
      });
    });
  }

  private handleFilesDrop(files: FileList, dropZone: HTMLElement) {
    const trackType = this.getTrackTypeFromDropZone(dropZone);
    const midiFiles = [...files].filter(file => file.type === 'audio/midi' || file.type === 'audio/x-midi' || file.name.toLowerCase().endsWith('.mid') || file.name.toLowerCase().endsWith('.midi'));
    const audioFiles = [...files].filter(file => file.type.startsWith('audio/') || ['mp3', 'wav', 'ogg', 'aac', 'm4a', 'flac'].some(ext => file.name.toLowerCase().endsWith(`.${ext}`)));
    if (midiFiles.length > 0) {
      this.importMidiFromFile(midiFiles[0]);
    }
    if (audioFiles.length > 0) {
      audioFiles.forEach(file => {
        const pitchShift = this.extractPitchShiftFromFilename(file.name);
        this.addAudioFile(file, pitchShift);
      });
      if (trackType) {
        this.setAudio(trackType, audioFiles[0]);
      }
    }
    if (midiFiles.length === 0 && audioFiles.length === 0) {
      alert(i18next.t('import_error_invalid_audio_file'));
    }
  }

  private getTrackTypeFromDropZone(dropZone: HTMLElement): string | null {
    // Check if it's the piano roll section (melody track)
    if (dropZone.classList.contains('piano-roll-section')) {
      return 'melody';
    }
    
    // Check if it's a rhythm track
    if (dropZone.classList.contains('rhythm-track')) {
      const trackIndex = dropZone.dataset.track;
      if (trackIndex === '0') {
        return 'beat1';
      } else if (trackIndex === '1') {
        return 'beat2';
      }
    }
    
    return null;
  }

  private addAudioFile(file: File, pitchShift: number = 0) {
    // すでに同じ名前のファイルがある場合は追加しない
    if (this.files.find(f => f.file.name === file.name)) {
      return;
    }
    this.files.push({ file, pitchShift });

    // すべてのサウンドセレクトにオプションを追加
    const soundSelects = document.querySelectorAll('.sound-select') as NodeListOf<HTMLSelectElement>;
    soundSelects.forEach(soundSelect => {
      const option = document.createElement('option');
      option.value = file.name;
      option.text = filenameToName(file.name);
      soundSelect.appendChild(option);
    });
  }

  private removeAudioFile(filename: string) {
    if (filename === 'sine') return;
    const soundSelects = document.querySelectorAll('.sound-select') as NodeListOf<HTMLSelectElement>;
    soundSelects.forEach(soundSelect => {
      // 指定のオプションを削除
      const optionToRemove = Array.from(soundSelect.options).find(opt => opt.value === filename);
      if (optionToRemove) {
        optionToRemove.remove();
      }
    });

    // ファイルリストから削除
    this.files = this.files.filter(f => f.file.name !== filename);
    
    this.filenames.melody.forEach((name, track) => {
      if (name === filename) {
        if (track === this.currentTrack) {
          this.setSine('melody');
        } else {
          this.filenames.melody.set(track, 'sine');
        }
      }
    });
    if (this.filenames.beat1 === filename) {
      this.setSine('beat1');
    }
    if (this.filenames.beat2 === filename) {
      this.setSine('beat2');
    }
  }

  private async setAudio(track: string, file: File | null = null) {
    const filename = file?.name || 'sine';
    const audioFile = this.files.find(f => f.file.name === filename) || null;
    const pitchShift = audioFile ? audioFile.pitchShift : 0;
    const isSine = filename === 'sine';
    const soundButtonsContainer = document.querySelector(`.sound[data-track="${track}"]`) as HTMLElement;
    const soundSelectLabel = soundButtonsContainer.querySelector('.sound-select-label') as HTMLElement;
    const soundSelect = soundButtonsContainer.querySelector('.sound-select') as HTMLSelectElement;
    const pitchShiftLabel = document.querySelector('.pitch-shift-label') as HTMLElement;
    const pitchShiftInput = document.getElementById('melody-pitch-shift') as HTMLInputElement;
    
    // Select要素の選択を更新
    soundSelect.value = filename;
    
    if (track === 'melody') {
      this.filenames.melody.set(this.currentTrack, filename);
      pitchShiftLabel.hidden = isSine;
      await this.audioManager.setMelodyAudio(file);
      if (pitchShift) {
        pitchShiftInput.valueAsNumber = pitchShift;
        this.audioManager.setMelodyPitchShift(filename, pitchShift);
      } else {
        pitchShiftInput.value = '';
      }
    } else if (track === 'beat1') {
      this.filenames.beat1 = filename;
      await this.audioManager.setBeatSample(0, file);
    } else if (track === 'beat2') {
      this.filenames.beat2 = filename;
      await this.audioManager.setBeatSample(1, file);
    }
    if (isSine) {
      soundSelectLabel.classList.remove('added-sound');
    } else {
      soundSelectLabel.classList.add('added-sound');
    }
  }

  private setSine(track: string) {
    return this.setAudio(track);
  }

  private getFilenameByTrack(track: number): string {
    return this.filenames.melody.get(track) || 'sine';
  }

  private extractPitchShiftFromFilename(filename: string): number {
    const name = filenameToName(filename);
    const match = name.match(/ps([-+]?\d+(\.\d+)?)$/);
    return match ? parseFloat(match[1]) : 0;
  }

  private initializePianoRoll() {
    const pianoRollSection = document.querySelector('.piano-roll-section') as HTMLElement;
    const pianoRoll = document.querySelector('.piano-roll-grid') as HTMLElement;

    if (!pianoRoll) return;

    pianoRollSection.addEventListener('animationend', () => {
      pianoRollSection.classList.remove('notify');
    });

    // Add keyboard listener for selection and deletion
    pianoRollSection.addEventListener('keydown', (e) => {
      // Ctrl+A (Cmd+A on Mac) to select all notes in current track
      if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
        e.preventDefault();
        const trackNotes = this.getCurrentTrackNotes();
        this.selectedNotes.clear();
        trackNotes.forEach(note => this.selectedNotes.add(note.id));
        this.updateSelectedNotesVisual();
      }
      // Delete or Backspace to remove selected notes
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedNotes.size > 0) {
        e.preventDefault();
        const notesToDelete = Array.from(this.selectedNotes);
        notesToDelete.forEach(noteId => this.removeNote(noteId));
        this.selectedNotes.clear();
        this.updateSelectedNotesVisual();
      }
    });

    // Add pointer listener for note creation
    const firstCurrent = { notePos: -1, pitch: -1 };
    const firstPointer = { notePos: -1, pitch: -1 };
    let currentNote: Note | null = null;
    let currentPreviewId: string | null = null;
    let beforePitch = -1;
    let isDragging = false;
    let isResizing = false;
    let shouldMove = false;

    const handlePointerOperation = (e: PointerEvent) => {
      const target = e.target as HTMLElement;
      const rect = pianoRoll.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      let pointerNotePosition = null;
      if (this.quantization < 0) {
        pointerNotePosition = x / Sequencer.noteWidth;
      } else {
        pointerNotePosition = multipleFloor(x / Sequencer.noteWidth, this.quantization);
      }
      const pointerNoteIndex = Math.floor(y / Sequencer.noteHeight);
      const pointerMidiNote = 108 - pointerNoteIndex; // C8 at top
      const isPointerDown = e.type === 'pointerdown';
      if (isPointerDown) {
        firstPointer.notePos = pointerNotePosition;
        firstPointer.pitch = pointerMidiNote;
        isResizing = x > target.offsetLeft + target.offsetWidth - 5;
      }
      if (!isResizing && (firstPointer.notePos !== pointerNotePosition || firstPointer.pitch !== pointerMidiNote)) {
        shouldMove = true;
      }

      // 範囲外の音程は無視
      if (pointerMidiNote < 21 || pointerMidiNote > 108) {
        return;
      }

      // Prevent adding if note already exists at this pitch
      let trackNotes = this.getCurrentTrackNotes();
      const basisNotePosition = currentNote ? pointerNotePosition - (firstPointer.notePos - firstCurrent.notePos) : pointerNotePosition;
      const basisNoteLength = currentNote ? currentNote.length : this.defaultNoteLength;
      const exists = trackNotes.some(
        n =>
          n.start < basisNotePosition + basisNoteLength && n.start + n.length > basisNotePosition
          && n.pitch === pointerMidiNote
          && n !== currentNote
      );
      if (exists) return;

      if (currentNote) {
        const deltaNotePos = pointerNotePosition - firstPointer.notePos;
        const deltaPitch = pointerMidiNote - firstPointer.pitch;
        const newNotePos = firstCurrent.notePos + deltaNotePos;
        const newPitch = firstCurrent.pitch + deltaPitch;
        if (!isPointerDown && newNotePos === currentNote.start && newPitch === currentNote.pitch) {
          return;
        }
        if (shouldMove) {
          this.moveNote(currentNote.id, newNotePos, newPitch);
          this.scrollByDragging(e);
        }
      } else {
        const id = this.addNote(pointerMidiNote, pointerNotePosition, this.defaultNoteLength);
        trackNotes = this.getCurrentTrackNotes();
        currentNote = trackNotes.find(n => n.id === id)!;
        firstCurrent.notePos = currentNote.start;
        firstCurrent.pitch = currentNote.pitch;
      }

      if (currentNote.pitch === beforePitch) {
        return;
      }
      beforePitch = currentNote.pitch;

      // 前の音を停止して新しい音を再生
      if (currentPreviewId) {
        this.audioManager.stopPreview(currentPreviewId);
      }
      
      currentPreviewId = `preview-${Date.now()}`;
      const filename = this.getFilenameByTrack(currentNote.track);
      this.audioManager.playNotePreview(currentNote, filename, this.bpm * this.playbackSpeed, currentPreviewId);
    };

    pianoRoll.addEventListener('pointerdown', (e) => {
      if (!e.isPrimary || e.button !== 0) return; // 左クリックのみ
      if ((e as PointerEvent).pointerType === 'touch' && this.multiTouched) return; // 2本以上の指ならノート操作を無視
      
      // Ctrlキーが押されている場合は矩形選択開始
      if (e.ctrlKey || e.metaKey) {
        this.startRectangleSelection(e, pianoRoll);
        return;
      }
      
      const target = e.target as HTMLElement;
      const isNote = target.classList.contains('note');
      const isCurrentNote = target.dataset.track === String(this.currentTrack);
      
      // 現在のトラック以外のノートは操作不可
      if (isNote && !isCurrentNote) {
        return;
      }

      const trackNotes = this.getCurrentTrackNotes();
      
      currentNote = trackNotes.find(note => note.id === target.dataset.noteId) || null;
      
      // 選択されたノートがある場合は、それらを一緒に移動
      if (currentNote && this.selectedNotes.has(currentNote.id)) {
        this.startSelectedNotesMove(e, pianoRoll);
        return;
      }
      this.selectedNotes.clear();
      this.updateSelectedNotesVisual();
      
      // 通常の単一ノート操作
      if (currentNote) {
        firstCurrent.notePos = currentNote.start;
        firstCurrent.pitch = currentNote.pitch;
      } else {
        firstCurrent.notePos = -1;
        firstCurrent.pitch = -1;
      }
      beforePitch = -1;
      isDragging = true;
      shouldMove = false;
      currentPreviewId = null;
      handlePointerOperation(e);
    });

    pianoRoll.addEventListener('pointermove', (e) => {
      if (!e.isPrimary || e.buttons !== 1) return; // 左クリックのみ
      if ((e as PointerEvent).pointerType === 'touch' && this.multiTouched) {
        const noteId = currentNote?.id || null;
        if (noteId) {
          this.removeNote(noteId);
          currentNote = null;
        }
        if (currentPreviewId) {
          this.audioManager.stopPreview(currentPreviewId);
          currentPreviewId = null;
        }
        return; // マルチタッチ中の移動は無視
      }
      
      if (this.isRectangleSelecting) {
        this.updateSelectionBox(e, pianoRoll);
      } else if (isDragging) {
        handlePointerOperation(e);
      }
    });

    document.addEventListener('pointerup', (e) => {
      if (!e.isPrimary || e.button !== 0) return; // 左クリックのみ
      if ((e as PointerEvent).pointerType === 'touch' && this.multiTouched) {
        const noteId = currentNote?.id || null;
        if (noteId) {
          this.removeNote(noteId);
          currentNote = null;
        }
        if (currentPreviewId) {
          this.audioManager.stopPreview(currentPreviewId);
          currentPreviewId = null;
        }
        return; // マルチタッチ中の移動は無視
      }
      
      if (this.isRectangleSelecting) {
        this.endRectangleSelection(pianoRoll);
        return;
      }
      
      if (!isDragging) {
        return;
      }
      isDragging = false;
      this.audioManager.stopAllPreviews();
    });

    const removeNoteByEvent = (e: MouseEvent | CustomEvent) => {
      const target = (e?.detail?.originalTarget as HTMLElement) || (e.target as HTMLElement);
      const noteId = target.dataset.noteId || null;
      const isCurrentNote = target.dataset.track === String(this.currentTrack);
      // 非アクティブなノートは削除できない
      if (noteId && isCurrentNote) {
        this.removeNote(noteId);
      }
    };
    dispatchPointerPressEvent(pianoRoll);
    pianoRoll.addEventListener('dblclick', removeNoteByEvent);
    pianoRoll.addEventListener('pointerpress', (e) => {
      removeNoteByEvent(e as CustomEvent);
    });
  }

  private initializeRhythmSection() {
    const section = document.querySelector('.rhythm-section') as HTMLElement;
    this.createBeats();

    let isPointerDown = false;
    let shoudRemove = false
    section.addEventListener('pointerdown', (e: PointerEvent) => {
      if (!e.isPrimary || e.button !== 0) return; // 左クリックのみ
      const target = e.target as HTMLElement;
      if (target.classList.contains('beat')) {
        const position = parseFloat(target.dataset.position!);
        const track = parseInt(target.dataset.track!);
        if (target.classList.contains('active')) {
          this.removeBeat(track, position);
          shoudRemove = true;
        } else {
          this.addBeat(track, position);
          shoudRemove = false;
        }
      }
      isPointerDown = true;
    });

    section.addEventListener('pointermove', (e: PointerEvent) => {
      if (!isPointerDown) return;
      const target = e.target as HTMLElement;
      if (target.classList.contains('beat')) {
        const position = parseFloat(target.dataset.position!);
        const track = parseInt(target.dataset.track!);
        if (shoudRemove) {
          this.removeBeat(track, position);
        } else {
          this.addBeat(track, position);
        }
      }
    });

    section.addEventListener('pointerup', (e: PointerEvent) => {
      if (!e.isPrimary || e.button !== 0) return; // 左クリックのみ
      isPointerDown = false;
    });
  }

  private setupNoteDragResize() {
    let note: Note | null = null;
    let isResizable = false;
    let isResizing = false;
    let currentNote: HTMLElement | null = null;
    let startX = 0;
    let originalWidth = 0;

    const pianoRoll = document.querySelector('.piano-roll-grid');
    if (!pianoRoll) return;

    pianoRoll.addEventListener('pointerdown', (e: Event) => {
      const pointerEvent = e as PointerEvent;
      const target = e.target as HTMLElement;
      const isNote = target.classList.contains('note');
      const isCurrentNote = target.dataset.track === String(this.currentTrack);
      if (isNote && isCurrentNote) {
        // Check if clicking near the right edge for resizing
        isResizing = isResizable;
        if (isResizing) {
          currentNote = target;
          startX = pointerEvent.clientX;
          originalWidth = target.offsetWidth;
          e.preventDefault();
        }
      }
    });

    document.addEventListener('pointermove', (e: Event) => {
      const pointerEvent = e as PointerEvent;
      const target = e.target as HTMLElement;
      const isNote = target.classList.contains('note');
      const isCurrentNote = target.dataset.track === String(this.currentTrack);
      if (isNote && isCurrentNote) {
        const rect = target.getBoundingClientRect();
        const x = pointerEvent.clientX - rect.left;

        isResizable = x > rect.width - 5;
      } else {
        isResizable = false;
      }
      if (isResizing) {
        pianoRoll.classList.add('note-resize');
      } else {
        pianoRoll.classList.remove('note-resize');
      }
      if (isResizing && currentNote) {
        const deltaX = pointerEvent.clientX - startX;
        let newNoteValue = null;
        if (this.quantization < 0) {
          newNoteValue = Math.max(0.1, (originalWidth + deltaX) / Sequencer.noteWidth);
        } else {
          newNoteValue = Math.max(this.quantization, multipleFloor((originalWidth + deltaX) / Sequencer.noteWidth, this.quantization));
        }
        currentNote.style.setProperty('--length', newNoteValue.toString());

        // Update note data
        const noteId = currentNote.dataset.noteId!;
        const trackNotes = this.getCurrentTrackNotes();
        note = trackNotes.find(n => n.id === noteId) || null;
        if (note) {
          note.length = newNoteValue;
          this.updateNoteMeta(currentNote, note);
        }
      }
    });

    document.addEventListener('pointerup', () => {
      if (isResizing && note) {
        this.defaultNoteLength = note.length;
      }
      note = null;
      isResizing = false;
      currentNote = null;
    });
  }

  private setupTrackScrolling() {
    const trackSelector = document.getElementById('track-selector');
    if (!trackSelector) return;

    let moveStrage = 0;
    trackSelector.addEventListener('wheel', (e: WheelEvent) => {
      e.preventDefault();
      moveStrage += e.deltaY;
      if (Math.abs(moveStrage) < 20) return;
      const direction = moveStrage > 0 ? 1 : -1;
      this.switchToNextTrack(direction);
      moveStrage = 0;
    });

    let isPointerDown = false;
    let beforeY = 0;
    trackSelector.addEventListener('pointerdown', (e: PointerEvent) => {
      if (!e.isPrimary || e.button !== 0) return; // 左クリックのみ
      e.stopPropagation();
      isPointerDown = true;
      beforeY = e.clientY;
    });

    let captured = false;
    trackSelector.addEventListener('pointermove', (e: PointerEvent) => {
      if (!isPointerDown) return;
      if (!captured) {
        trackSelector.setPointerCapture(e.pointerId);
        captured = true;
      }
      const y = e.clientY;
      const distance = beforeY - y;

      if (Math.abs(distance) > 40) {
        const direction = distance > 0 ? 1 : -1;
        this.switchToNextTrack(direction);
        beforeY = y;
      }
    });

    trackSelector.addEventListener('pointerup', (e: PointerEvent) => {
      if (!e.isPrimary || e.button !== 0) return; // 左クリックのみ
      isPointerDown = false;
      trackSelector.releasePointerCapture(e.pointerId);
      captured = false;
    });

    trackSelector.addEventListener('pointerleave', () => {
      isPointerDown = false;
    });
  }

  private async setupLocalForage() {
    localForage.config({
      name: 'AnySoundSequencer',
      storeName: 'sequencer_data'
    });

    // Load saved data
    const savedTitle = await localForage.getItem<string>('title');
    const savedNotes = await localForage.getItem<Note[]>('notes');
    const savedBeats = await localForage.getItem<Beat[]>('beats');
    const savedBpm = await localForage.getItem<number>('bpm');
    const savedBpms = await localForage.getItem<Map<number, number>>('bpms');
    const savedPlaybackSpeed = await localForage.getItem<number>('playbackSpeed');
    const savedQuantization = await localForage.getItem<number>('quantization');
    const savedAudioFiles = await localForage.getItem<AudioFile[]>('audioFiles');
    const savedAudioFilenames = await localForage.getItem<Filenames>('audioFilenames');
    const savedInstrumentCodes = await localForage.getItem<InstrumentCodes>('instrumentCodes');
    const savedGridSize = await localForage.getItem<number>('gridSize');

    if (savedGridSize) {
      this.gridSize = savedGridSize;
      (document.querySelector('.sequencer-container') as HTMLElement).style.setProperty('--grid-size', this.gridSize.toString());
    }

    if (savedTitle) {
      this.title = savedTitle;
      const titleInput = document.getElementById('title-input') as HTMLInputElement;
      if (titleInput) titleInput.value = this.title;
    }

    if (savedNotes) {
      this.notes = savedNotes;
      // Render notes (will be re-rendered in renderTracks)
    }

    if (savedBeats) {
      this.beats = savedBeats;
      // Render beats
      document.querySelectorAll('.beat').forEach(beat => beat.remove());
      this.createBeats();
      this.beats.forEach(beat => this.renderBeat(beat));
    }

    if (savedBpm) {
      this.bpm = savedBpm;
      const bpmSlider = document.getElementById('bpm-slider') as HTMLInputElement;
      const bpmValue = document.getElementById('bpm-value') as HTMLInputElement;
      if (bpmSlider) bpmSlider.valueAsNumber = this.bpm;
      if (bpmValue) bpmValue.valueAsNumber = this.bpm;
    }

    if (savedBpms) {
      this.bpms = savedBpms;
    }

    if (savedPlaybackSpeed) {
      this.playbackSpeed = savedPlaybackSpeed;
      const speedSelect = document.getElementById('speed-select') as HTMLSelectElement;
      if (speedSelect) speedSelect.value = this.playbackSpeed.toString();
    }

    if (savedQuantization !== null && !isNaN(savedQuantization)) {
      this.quantization = savedQuantization;
      document.querySelectorAll('.beat').forEach(beat => beat.remove());
      this.createBeats();
      this.beats.forEach(beat => this.renderBeat(beat));
      const quantizationSelect = document.getElementById('quantization-select') as HTMLSelectElement;
      if (quantizationSelect) quantizationSelect.value = this.quantization.toString();
    }

    if (savedInstrumentCodes) {
      this.instrumentCodes = savedInstrumentCodes;
      const instrumentNameOutput = document.getElementById('instrument-name') as HTMLOutputElement;
      if (instrumentNameOutput) {
        const currentInstrumentCode = this.instrumentCodes[this.currentTrack] || -1;
        instrumentNameOutput.dataset.gmNum = currentInstrumentCode.toString();
        instrumentNameOutput.value = this.gmInstrumentCodeToName(currentInstrumentCode);
      }
    }

    if (savedAudioFiles) {
      if (!Array.isArray(savedAudioFiles)) {
        console.error('Saved audio files data is corrupted.');
        return;
      }
      this.files = savedAudioFiles;

      // オーディオマネージャーに音源をセット
      this.files.forEach(({ file, pitchShift }) => {
        this.audioManager.setMelodyAudio(file);
        this.audioManager.setMelodyPitchShift(file.name, pitchShift);
      });

      // すべてのサウンドセレクトにオプションを追加
      const soundSelects = document.querySelectorAll('.sound-select') as NodeListOf<HTMLSelectElement>;
      soundSelects.forEach(soundSelect => {
        this.files.forEach(({ file }) => {
          const option = document.createElement('option');
          option.value = file.name;
          option.text = filenameToName(file.name);
          soundSelect.appendChild(option);
        });
      });
      if (savedAudioFilenames) {
        this.filenames = savedAudioFilenames;
        Object.entries(savedAudioFilenames).forEach(([track, value]) => {
          const container = document.querySelector(`.sound[data-track="${track}"]`) as HTMLElement;
          const soundSelectLabel = container.querySelector('.sound-select-label') as HTMLElement;
          const soundSelect = container.querySelector('.sound-select') as HTMLSelectElement;
          if (track === 'melody') {
            const filenames = value as Map<number, string>;
            const filename = filenames.get(this.currentTrack) || 'sine';
            const audioFile = this.files.find(f => f.file.name === filename) || null;
            if (audioFile && audioFile.pitchShift) {
              const pitchShiftInput = document.getElementById('melody-pitch-shift') as HTMLInputElement;
              if (pitchShiftInput) pitchShiftInput.valueAsNumber = audioFile.pitchShift;
            }
            const pitchShiftLabel = document.querySelector('.pitch-shift-label') as HTMLElement;
            const isSine = filename === 'sine';
            soundSelect.value = filename;
            pitchShiftLabel.hidden = isSine;
          } else {
            const filename = value as string | null || 'sine';
            const file = this.files.find(f => f.file.name === filename)?.file || null;
            soundSelect.value = filename;
            if (!file) return;
            if (track === 'beat1') {
              this.audioManager.setBeatSample(0, file);
            } else if (track === 'beat2') {
              this.audioManager.setBeatSample(1, file);
            }
          }
          const isSine = soundSelect.value === 'sine';
          if (isSine) {
            soundSelectLabel.classList.remove('added-sound');
          } else {
            soundSelectLabel.classList.add('added-sound');
          }
        });
      }
    }

    this.renderTracks();
  }

  private updateViewPort() {
    const rolls = document.querySelector('.rolls') as HTMLElement;
    const rhythmSection = document.querySelector('.rhythm-section') as HTMLElement;
    
    // 現在の表示範囲を計算
    const scrollLeft = rolls.scrollLeft;
    const scrollTop = rolls.scrollTop;
    const viewWidth = rolls.clientWidth;
    const viewHeight = rolls.clientHeight;
    const rhythmSectionHeight = rhythmSection.clientHeight;
    const adjustedViewHeight = viewHeight - rhythmSectionHeight;
    
    // ビート範囲（少し余裕を持たせる）
    this.viewPort.startBeat = Math.max(0, Math.floor(scrollLeft / Sequencer.noteWidth) - 2);
    this.viewPort.endBeat = Math.ceil((scrollLeft + viewWidth) / Sequencer.noteWidth) + 2;

    // ピッチ範囲
    this.viewPort.startPitch = 108 - Math.max(0, Math.floor(scrollTop / Sequencer.noteHeight) - 2);
    this.viewPort.endPitch = 108 - Math.min(127, Math.ceil((scrollTop + adjustedViewHeight) / Sequencer.noteHeight) + 2);
  }

  private isNoteVisible(note: Note): boolean {
    return note.start + note.length > this.viewPort.startBeat! &&
           note.start < this.viewPort.endBeat! &&          
           note.pitch <= this.viewPort.startPitch! &&
           note.pitch >= this.viewPort.endPitch!;
  }

  private scrollByDragging(e: PointerEvent, horizontalOnly: boolean = false) {
    const rolls = document.querySelector('.rolls') as HTMLElement;
    if (!rolls) return;

    const rollsRect = rolls.getBoundingClientRect();
    const x = e.clientX - rollsRect.left, y = e.clientY - rollsRect.top;
    const edgeThreshold = 50;
    const rhythmSection = document.querySelector('.rhythm-section') as HTMLElement;
    const rhythmSectionHeight = rhythmSection.clientHeight;

    if (!horizontalOnly && y > rollsRect.height - edgeThreshold - rhythmSectionHeight) {
      rolls.scrollBy({ top: 20 });
    }
    if (x > rollsRect.width - edgeThreshold) {
      rolls.scrollBy({ left: 20 });
    }
    if (!horizontalOnly && y < edgeThreshold) {
      rolls.scrollBy({ top: -20 });
    }
    if (x < edgeThreshold) {
      rolls.scrollBy({ left: -20 });
    }
  }

  private saveData() {
    localForage.setItem('title', this.title);
    localForage.setItem('notes', this.notes);
    localForage.setItem('beats', this.beats);
    localForage.setItem('bpm', this.bpm);
    localForage.setItem('bpms', this.bpms);
    localForage.setItem('playbackSpeed', this.playbackSpeed);
    localForage.setItem('quantization', this.quantization);
    localForage.setItem('audioFiles', this.files);
    localForage.setItem('audioFilenames', this.filenames);
    localForage.setItem('instrumentCodes', this.instrumentCodes);
    localForage.setItem('gridSize', this.gridSize);
  }

  private switchToNextTrack(direction: number) {
    const trackCount = 16;
    if (this.currentTrack + direction < 0 || this.currentTrack + direction >= trackCount) {
      return;
    }
    this.currentTrack = this.currentTrack + direction;

    // Update UI
    const pianoRollSection = document.querySelector('.piano-roll-section') as HTMLElement;
    if (pianoRollSection) {
      pianoRollSection.dataset.track = (this.currentTrack + 1).toString();
      resetAnimation(pianoRollSection, 'notify');
    }

    const melodySoundButtonsContainer = document.querySelector('.sound[data-track="melody"]') as HTMLElement;
    const soundSelectLabel = melodySoundButtonsContainer.querySelector('.sound-select-label') as HTMLElement;
    const soundSelect = melodySoundButtonsContainer.querySelector('.sound-select') as HTMLSelectElement;
    const pitchShiftLabel = document.querySelector('.pitch-shift-label') as HTMLElement;
    const instrumentNameOutput = document.getElementById('instrument-name') as HTMLOutputElement;

    const filename = this.filenames.melody.get(this.currentTrack) || 'sine';
    const isSine = filename === 'sine';
    soundSelect.value = filename;
    if (isSine) {
      soundSelectLabel.classList.remove('added-sound');
    } else {
      soundSelectLabel.classList.add('added-sound');
    }
    pitchShiftLabel.hidden = isSine;
    const audioFile = this.files.find(f => f.file.name === filename) || null;
    if (audioFile) {
      const pitchShiftInput = document.getElementById('melody-pitch-shift') as HTMLInputElement;
      if (pitchShiftInput) pitchShiftInput.valueAsNumber = audioFile.pitchShift;
    }
    const instrumentCode = this.instrumentCodes[this.currentTrack] || -1;
    instrumentNameOutput.dataset.gmNum = instrumentCode.toString();
    instrumentNameOutput.value = this.gmInstrumentCodeToName(instrumentCode);
    
    // Clear selected notes when switching tracks
    this.selectedNotes.clear();
  }

  private getCurrentTrackNotes(): Note[] {
    return this.notes.filter(note => note.track === this.currentTrack);
  }

  private setCurrentTrackNotes(notes: Note[]) {
    this.notes = this.notes.filter(note => note.track !== this.currentTrack);
    this.notes.push(...notes);
  }

  private addNote(pitch: number, start: number, length: number) {
    const trackNotes = this.getCurrentTrackNotes();
    const noteId = `note-${Date.now()}-${Math.random()}`;

    const note: Note = {
      id: noteId,
      track: this.currentTrack,
      pitch,
      start,
      length,
      velocity: 100
    };

    trackNotes.push(note);
    this.setCurrentTrackNotes(trackNotes);
    if (this.isNoteVisible(note)) {
      const noteElement = this.createNoteElement(note);
      const pianoRoll = document.querySelector('.piano-roll-grid') as HTMLElement;
      pianoRoll.appendChild(noteElement);
      this.visibleNoteElements.set(note.id, noteElement);
    }
    return noteId;
  }

  private moveNote(noteId: string, newStart: number, newPitch: number) {
    if (newStart < 0) newStart = 0;
    const trackNotes = this.getCurrentTrackNotes()
    const note = trackNotes.find(n => n.id === noteId);
    if (note) {
      note.start = newStart;
      note.pitch = newPitch;

      // Update note element position
      const noteElement = document.querySelector(`[data-note-id="${noteId}"]`) as HTMLElement;
      if (noteElement) {
        this.updateNoteMeta(noteElement, note);
      }
    }
  }

  private removeNote(noteId: string) {
    const trackNotes = this.getCurrentTrackNotes()
    const filteredNotes = trackNotes.filter(note => note.id !== noteId);
    this.setCurrentTrackNotes(filteredNotes);
    const element = this.visibleNoteElements.get(noteId);
    if (element) {
      element.remove();
      this.visibleNoteElements.delete(noteId);
    }
  }

  private clearSounds() {
    this.files.forEach(audioFile => {
      this.audioManager.deleteMelodyAudio(audioFile.file.name);
    });
    this.files = [];
    this.filenames = {
      melody: new Map<number, string>(),
      beat1: null,
      beat2: null
    };
    this.audioManager.setBeatSample(0, null);
    this.audioManager.setBeatSample(1, null);

    const soundButtonsContainers = document.querySelectorAll('.sound');
    soundButtonsContainers.forEach(container => {
      const soundSelectLabel = container.querySelector('.sound-select-label') as HTMLElement;
      const soundSelect = container.querySelector('.sound-select') as HTMLSelectElement;
      // Select要素から追加されたオプションを削除
      Array.from(soundSelect.options).forEach(option => {
        if (option.value !== 'sine' && option.value !== 'add-sound') {
          option.remove();
        }
      });
      soundSelect.value = 'sine';
      soundSelectLabel.classList.remove('added-sound');
    });
    const pitchShiftLabel = document.querySelector('.pitch-shift-label') as HTMLElement;
    if (pitchShiftLabel) pitchShiftLabel.hidden = true;
    const pitchShiftInput = document.getElementById('melody-pitch-shift') as HTMLInputElement;
    if (pitchShiftInput) pitchShiftInput.value = '';
  }

  private clearAll() {
    this.stop();
    this.title = i18next.t('untitled');
    this.notes = [];
    this.beats = [];
    this.bpm = 120;
    this.bpms = new Map();
    this.playbackSpeed = 1;
    this.instrumentCodes = {};
    this.gridSize = 64;

    // Clear UI
    const titleInput = document.getElementById('title-input') as HTMLInputElement;
    if (titleInput) titleInput.value = this.title;
    const sequencerContainer = document.querySelector('.sequencer-container') as HTMLElement;
    if (sequencerContainer) sequencerContainer.style.setProperty('--grid-size', this.gridSize.toString());
    const pianoRollSection = document.querySelector('.piano-roll-section') as HTMLElement;
    if (pianoRollSection) pianoRollSection.dataset.track = '1'; 
    document.querySelectorAll('.note').forEach(note => note.remove());
    document.querySelectorAll('.beat').forEach(beat => beat.remove());
    this.createBeats();
    this.beats.forEach(beat => this.renderBeat(beat));
    const instrumentNameOutput = document.getElementById('instrument-name') as HTMLOutputElement;
    if (instrumentNameOutput) {
      instrumentNameOutput.dataset.gmNum = '-1';
      instrumentNameOutput.value = this.gmInstrumentCodeToName(-1);
    }
    const bpmSlider = document.getElementById('bpm-slider') as HTMLInputElement;
    const bpmValue = document.getElementById('bpm-value') as HTMLInputElement;
    if (bpmSlider) bpmSlider.valueAsNumber = this.bpm;
    if (bpmValue) bpmValue.valueAsNumber = this.bpm;
    const speedSelect = document.getElementById('speed-select') as HTMLSelectElement;
    if (speedSelect) speedSelect.value = this.playbackSpeed.toString();
    const loopToggle = document.getElementById('loop-toggle') as HTMLInputElement;
    if (loopToggle) loopToggle.checked = true;
    this.clearSounds();
  }
  
  private createNoteElement(note: Note): HTMLElement {
    const noteElement = document.createElement('div');
    noteElement.classList.add('note');
    noteElement.classList.add(`note-track-${note.track + 1}`);
    noteElement.dataset.noteId = note.id;
    noteElement.dataset.track = note.track.toString();
    this.updateNoteMeta(noteElement, note);
    return noteElement;
  }

  private updateNoteMeta(noteElement: HTMLElement, note: Note) {
    const noteName = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][note.pitch % 12];
    const octave = Math.floor(note.pitch / 12) - 1;
    noteElement.textContent = noteName + octave;
    noteElement.title = `${noteName}${octave} (${note.pitch})\nStart: ${note.start} beat\nLength: ${note.length} beat`;

    noteElement.style.setProperty('--pitch', note.pitch.toString());
    noteElement.style.setProperty('--start', note.start.toString());
    noteElement.style.setProperty('--length', note.length.toString());
  }

  private addBeat(track: number, position: number) {
    const existingBeatIndex = this.beats.findIndex(
      beat => beat.track === track && beat.position === position
    );
    if (existingBeatIndex >= 0) return;
    const beat: Beat = {
      id: `beat-${Date.now()}-${Math.random()}`,
      track,
      position,
      velocity: 100
    };
    this.beats.push(beat);
    document.querySelector(`[data-track="${track}"] [data-position="${position}"]`)?.classList.add('active');
    this.audioManager.playBeat(beat);
  }

  private removeBeat(track: number, position: number) {
    const existingBeatIndex = this.beats.findIndex(
      beat => beat.track === track && beat.position === position
    );
    if (existingBeatIndex == -1) return;
    this.beats.splice(existingBeatIndex, 1);
    document.querySelector(`[data-track="${track}"] [data-position="${position}"]`)?.classList.remove('active');
  }

  private createBeats() {
    const adjustedQuantization = this.quantization > 0 ? this.quantization : 0.1;
    document.querySelectorAll('.rhythm-grid').forEach((grid, trackIndex) => {
      // Create beats grid
      for (let i = 0; i < this.gridSize; i += adjustedQuantization) {
        const beatElement = document.createElement('div');
        beatElement.className = 'beat';
        beatElement.dataset.position = i.toString();
        beatElement.dataset.track = trackIndex.toString();

        grid.appendChild(beatElement);
      }
    });
    (document.querySelector('.sequencer-container') as HTMLElement)?.style.setProperty('--quantization', adjustedQuantization.toString());
  }

  private renderBeat(beat: Beat) {
    document.querySelector(`[data-track="${beat.track}"] [data-position="${beat.position}"]`)?.classList.add('active');
  }

  private renderTracks() {
    this.updateViewPort();

    const pianoRoll = document.querySelector('.piano-roll-grid') as HTMLElement;

    for (const [noteId, element] of this.visibleNoteElements) {
      const note = this.notes.find(n => n.id === noteId);
      if (!note || !this.isNoteVisible(note)) {
        element.remove();
        this.visibleNoteElements.delete(noteId);
      }
    }

    for (const note of this.notes) {
      if (this.isNoteVisible(note) && !this.visibleNoteElements.has(note.id)) {
        const noteElement = this.createNoteElement(note);
        pianoRoll.appendChild(noteElement);
        this.visibleNoteElements.set(note.id, noteElement);
      }
    }

    this.updateSelectedNotesVisual();
  }

  private startRectangleSelection(e: PointerEvent, pianoRoll: HTMLElement) {
    this.isRectangleSelecting = true;
    const rect = pianoRoll.getBoundingClientRect();
    this.selectionStartX = e.clientX - rect.left;
    this.selectionStartY = e.clientY - rect.top;
    
    // 既存の選択をクリア（Shiftキーが押されていない場合）
    if (!e.shiftKey) {
      this.selectedNotes.clear();
      this.updateSelectedNotesVisual();
    }
    
    // 選択矩形を作成
    this.createSelectionBox(pianoRoll);
  }

  private createSelectionBox(pianoRoll: HTMLElement) {
    // 既存の選択矩形を削除
    const existingBox = pianoRoll.querySelector('.selection-box');
    if (existingBox) {
      existingBox.remove();
    }
    
    const selectionBox = document.createElement('div');
    selectionBox.className = 'selection-box';
    selectionBox.style.position = 'absolute';
    selectionBox.style.pointerEvents = 'none';
    selectionBox.style.zIndex = '1000';
    pianoRoll.appendChild(selectionBox);
  }

  private updateSelectionBox(e: PointerEvent, pianoRoll: HTMLElement) {
    const rect = pianoRoll.getBoundingClientRect();
    const currentX = e.clientX - rect.left;
    const currentY = e.clientY - rect.top;
    
    const selectionBox = pianoRoll.querySelector('.selection-box') as HTMLElement;
    if (!selectionBox) return;
    
    const left = Math.min(this.selectionStartX, currentX);
    const top = Math.min(this.selectionStartY, currentY);
    const width = Math.abs(currentX - this.selectionStartX);
    const height = Math.abs(currentY - this.selectionStartY);
    
    selectionBox.style.left = `${left}px`;
    selectionBox.style.top = `${top}px`;
    selectionBox.style.width = `${width}px`;
    selectionBox.style.height = `${height}px`;
    
    // 矩形内のノートを選択
    this.selectNotesInRectangle(left, top, width, height);
    this.scrollByDragging(e);
  }

  private selectNotesInRectangle(left: number, top: number, width: number, height: number) {
    const trackNotes = this.getCurrentTrackNotes();
    const right = left + width;
    const bottom = top + height;
    
    trackNotes.forEach(note => {
      const noteElement = document.querySelector(`[data-note-id="${note.id}"]`) as HTMLElement;
      const isCurrentNote = note.track === this.currentTrack;
      if (!noteElement || !isCurrentNote) return; // 非アクティブノートは選択対象外

      const noteLeft = note.start * Sequencer.noteWidth;
      const noteTop = (108 - note.pitch) * Sequencer.noteHeight;
      const noteRight = noteLeft + note.length * Sequencer.noteWidth;
      const noteBottom = noteTop + Sequencer.noteHeight;

      // 矩形との重なりをチェック
      const overlaps = !(noteRight < left || noteLeft > right || noteBottom < top || noteTop > bottom);
      
      if (overlaps) {
        this.selectedNotes.add(note.id);
      }
    });
    
    this.updateSelectedNotesVisual();
  }

  private updateSelectedNotesVisual() {
    // 全ての選択状態をリセット
    document.querySelectorAll('.note').forEach(noteElement => {
      noteElement.classList.remove('selected');
    });
    
    // 選択されたノートにクラスを追加
    this.selectedNotes.forEach(noteId => {
      const noteElement = document.querySelector(`[data-note-id="${noteId}"]`);
      if (noteElement) {
        noteElement.classList.add('selected');
      }
    });
  }

  private startSelectedNotesMove(e: PointerEvent, pianoRoll: HTMLElement) {
    // 選択されたノートの初期位置を記録
    const rect = pianoRoll.getBoundingClientRect();
    const startX = e.clientX - rect.left;
    const startY = e.clientY - rect.top;
    
    const selectedNotesData = new Map<string, {note: Note, initialStart: number, initialPitch: number}>();
    this.selectedNotes.forEach(noteId => {
      const trackNotes = this.getCurrentTrackNotes();
      const note = trackNotes.find(n => n.id === noteId);
      if (note) {
        selectedNotesData.set(noteId, {
          note,
          initialStart: note.start,
          initialPitch: note.pitch
        });
      }
    });

    let lastPreviewPitch = -1;
    const movePreviewId = `move-preview-${Date.now()}`;

    const moveHandler = (moveEvent: PointerEvent) => {
      const currentRect = pianoRoll.getBoundingClientRect();
      const currentX = moveEvent.clientX - currentRect.left;
      const currentY = moveEvent.clientY - currentRect.top;
      
      const deltaX = currentX - startX;
      const deltaY = currentY - startY;
      
      const deltaBeat = deltaX / Sequencer.noteWidth;
      const deltaPitch = -Math.round(deltaY / Sequencer.noteHeight); // Y軸は反転

      selectedNotesData.forEach(({note, initialStart, initialPitch}) => {
        let newStart = null;
        if (this.quantization < 0) {
          newStart = Math.max(0, initialStart + deltaBeat);
        } else {
          newStart = Math.max(0, multipleFloor(initialStart + deltaBeat, this.quantization));
        }
        const newPitch = minmax(initialPitch + deltaPitch, 21, 108);
        this.moveNote(note.id, newStart, newPitch);
      });

      const firstNoteData = Array.from(selectedNotesData.values())[0];
      if (firstNoteData) {
        const newPitch = minmax(firstNoteData.initialPitch + deltaPitch, 21, 108);
        if (newPitch !== lastPreviewPitch) {
          const filename = this.getFilenameByTrack(firstNoteData.note.track);
          this.audioManager.playNotePreview(firstNoteData.note, filename, this.bpm * this.playbackSpeed, movePreviewId);
          lastPreviewPitch = newPitch;
        }
      }

      this.scrollByDragging(moveEvent);
    };
    
    const upHandler = () => {
      this.audioManager.stopPreview(movePreviewId);
      document.removeEventListener('pointermove', moveHandler);
      document.removeEventListener('pointerup', upHandler);
    };
    
    document.addEventListener('pointermove', moveHandler);
    document.addEventListener('pointerup', upHandler);
  }

  private endRectangleSelection(pianoRoll: HTMLElement) {
    this.isRectangleSelecting = false;
    
    // 選択矩形を削除
    const selectionBox = pianoRoll.querySelector('.selection-box');
    if (selectionBox) {
      selectionBox.remove();
    }
  }

  private getEndOfTrack(): number {
    return Array.from(this.notes.values()).flat().map(n => n.start + n.length)
      .concat(this.beats.map(b => b.position + this.quantization)).reduce((a, b) => Math.max(a, b), 0);
  }

  private calculateDuration(): number {
    if (this.bpms.size > 0) {
      // BPM changes exist, calculate duration more accurately
      const bpms = Array.from(this.bpms.entries());
      let durationSeconds = 0;
      for (let i = 0, j = 1; i < bpms.length - 1; i++, j++) {
        const [beatA, bpmA] = bpms[i], [beatB] = bpms[j];
        const segmentBeats = beatB - beatA;
        durationSeconds += (segmentBeats * 60) / (bpmA * this.playbackSpeed);
      }
      const [lastBeat, lastBpm] = bpms[bpms.length - 1];
      const remainingBeats = this.getEndOfTrack() - lastBeat;
      durationSeconds += (remainingBeats * 60) / (lastBpm * this.playbackSpeed);
      return durationSeconds;
    } else {
      return (this.getEndOfTrack() * 60) / (this.bpm * this.playbackSpeed);
    }
  }

  private recordBpmChanged() {
    if (this.paused) return;
    
    // 新しいBPMでの基準点を更新
    this.bpmChanged = {
      time: performance.now(),
      beat: this.currentBeat
    };

    // Update Media Session position state
    if ('mediaSession' in navigator) {
      const duration = this.calculateDuration();
      navigator.mediaSession.setPositionState({
        duration,
        position: duration * (this.currentBeat / this.getEndOfTrack()),
      });
    }
  }

  private resetPlayback() {
    this.currentBeat = 0;
    if (!this.paused) {
      this.recordBpmChanged();
    }
    this.playedNotes.clear();
    this.autoScroll = true;
    const rolls = document.querySelector('.rolls') as HTMLElement;
    const playbackPosition = document.querySelector('.playback-position') as HTMLElement;
    rolls.scrollTo({ left: 0 });
    playbackPosition.style.removeProperty('--position');
  }

  private getCurrentBeat(now = performance.now()): number {
      const elapsedSinceLastBpmChange = (now - this.bpmChanged.time) / 1000;
      const beatsSinceLastBpmChange = elapsedSinceLastBpmChange * (this.bpm * this.playbackSpeed) / 60;
      const currentBeat = this.bpmChanged.beat + beatsSinceLastBpmChange;
      return currentBeat;
  }

  private applyTempoChangesUpTo(targetBeat: number) {
    if (!this.bpms || this.bpms.size === 0) return;

    const newBpm = Array.from(this.bpms.entries()).find(([beat]) => beat >= this.bpmChanged.beat && beat <= targetBeat)?.[1];
    if (newBpm === undefined) return;

    // update bpm and time baseline
    if (!this.paused) {
      this.recordBpmChanged();
    }
    this.bpm = newBpm;

    // update UI elements
    const bpmSlider = document.getElementById('bpm-slider') as HTMLInputElement;
    const bpmValue = document.getElementById('bpm-value') as HTMLInputElement;
    if (bpmSlider) bpmSlider.valueAsNumber = this.bpm;
    if (bpmValue) bpmValue.valueAsNumber = this.bpm;
  }

  private gmInstrumentCodeToName(instrumentCode: number): string {
    if (instrumentCode < 0 || instrumentCode > 127) {
      return '';
    }
    return i18next.t(`general_midi.${String(instrumentCode).padStart(3, '0')}`);
  }

  private playNotes(currentBeat: number) {
    this.notes.forEach(note => {
      const noteIntersected = note.start <= currentBeat && note.start + note.length >= currentBeat;
      if (noteIntersected) {
        if (this.playedNotes.has(note.id)) return;
        const filename = this.getFilenameByTrack(note.track);
        this.audioManager.playNote(note, filename, this.bpm * this.playbackSpeed);
        this.playedNotes.add(note.id);
      } else if (this.playedNotes.has(note.id)) {
        this.playedNotes.delete(note.id);
      }
    });

    // Play beats at current beat
    this.beats.forEach(beat => {
      const beatIntersected = beat.position <= currentBeat && beat.position + 0.1 >= currentBeat;
      if (beatIntersected) {
        if (this.playedNotes.has(beat.id)) return;
        this.audioManager.playBeat(beat);
        this.playedNotes.add(beat.id);
      } else if (this.playedNotes.has(beat.id)) {
        this.playedNotes.delete(beat.id);
      }
    });
  }

  private async play() {
    if (this.ended) {
      this.resetPlayback();
      this.ended = false;
    }

    await this.audioManager.resume();
    this.paused = false;
    this.autoScroll = true;
    this.renderPlayButton();
    this.recordBpmChanged();
    // Update Media Session playback state
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'playing';
    }

    const playbackPosition = document.querySelector('.playback-position') as HTMLElement;

    const playRendering = (timeStamp: number) => {
      if (this.paused) return;
      requestAnimationFrame(playRendering);
      this.currentBeat = this.getCurrentBeat(timeStamp);
      
      // playbackPositionの位置を更新
      const positionInPixels = this.currentBeat * Sequencer.noteWidth;
      playbackPosition.style.setProperty('--position', `${positionInPixels}px`);

      if (this.autoScroll) {
        playbackPosition.scrollIntoView({ block: 'nearest', inline: 'center' });
      }
    };
    requestAnimationFrame(playRendering);

    const playLoop = () => {
      if (this.paused) return;
      setTimeout(playLoop, 1);
      this.currentBeat = this.getCurrentBeat();
      // Apply tempo changes that should take effect up to current beat
      this.applyTempoChangesUpTo(this.currentBeat);
      this.playNotes(this.currentBeat);
      if (this.currentBeat >= this.getEndOfTrack()) {
        const loopToggle = document.getElementById('loop-toggle') as HTMLInputElement;
        if (loopToggle.checked) {
          this.resetPlayback();
          return;
        }
        this.stop();
      }
    };

    playLoop();
  }

  private pauseStop() {
    this.paused = true;
    this.renderPlayButton();
    this.playedNotes.clear();
  }

  private pause() {
    this.pauseStop();
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'paused';
    }
  }

  private stop() {
    this.pauseStop();
    this.ended = true;
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'none';
    }
  }
  
  private renderPlayButton() {
    const playBtn = document.getElementById('play-btn') as HTMLButtonElement;
    if (this.paused) {
      playBtn.classList.remove('is-playing');
      playBtn.textContent = 'play_arrow';
      playBtn.dataset.i18n = 'play';
      playBtn.title = i18next.t('play');
    } else {
      playBtn.classList.add('is-playing');
      playBtn.textContent = 'pause';
      playBtn.dataset.i18n = 'pause';
      playBtn.title = i18next.t('pause');
    }
  }

  private async importMidiFromFile(file: File) {
    try {
      const arrayBuffer = await file.arrayBuffer();
      const data = new Uint8Array(arrayBuffer);
      
      const parser = new MidiParser(data);
      const midiFile = parser.parse();
      
      // Convert MIDI to sequencer format
      const sequencerData = MidiConverter.midiToSequencer(midiFile);
      
      // Clear existing data
      this.stop();
      this.notes = [];
      this.beats = [];
      
      // Load converted data
      this.notes = sequencerData.notes;
      this.beats = sequencerData.beats;
      this.instrumentCodes = sequencerData.instrumentCodes;
      this.bpm = sequencerData.bpms.size > 0 ? Array.from(sequencerData.bpms.values())[0] : 120;
      this.bpms = sequencerData.bpms;
      this.gridSize = Math.max(64, sequencerData.gridSize);
      
      // Update UI
      const sequencerContainer = document.querySelector('.sequencer-container') as HTMLElement;
      const instrumentNameOutput = document.getElementById('instrument-name') as HTMLOutputElement;
      const bpmSlider = document.getElementById('bpm-slider') as HTMLInputElement;
      const bpmValue = document.getElementById('bpm-value') as HTMLInputElement;
      if (sequencerContainer) {
        sequencerContainer.style.setProperty('--grid-size', this.gridSize.toString());
      }
      if (instrumentNameOutput) {
        const instrumentCode = this.instrumentCodes[this.currentTrack] || -1;
        instrumentNameOutput.dataset.gmNum = instrumentCode.toString();
        instrumentNameOutput.value = this.gmInstrumentCodeToName(instrumentCode);
      }
      if (bpmSlider) bpmSlider.valueAsNumber = this.bpm;
      if (bpmValue) bpmValue.valueAsNumber = this.bpm;
      
      // Re-render tracks
      this.renderTracks();
      
      // Render beats
      document.querySelectorAll('.beat').forEach(beat => beat.remove());
      this.createBeats();
      this.beats.forEach(beat => this.renderBeat(beat));
      
      // Save data
      this.saveData();
      
      this.title = filenameToName(file.name);
      const titleInput = document.getElementById('title-input') as HTMLInputElement;
      if (titleInput) {
        titleInput.value = this.title;
      }
      console.log('MIDI file imported successfully');
    } catch (error) {
      console.error('Error importing MIDI file:', error);
      alert(i18next.t('import_error_invalid_midi_file'));
    }
  }

  // MIDI Import functionality
  private importMidi() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.mid,.midi';
    
    input.addEventListener('change', (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;

      this.importMidiFromFile(file);
    });
    
    input.click();
  }

  // MIDI Export functionality
  private exportMidi() {
    try {
      // Convert sequencer data to MIDI format
      const midiFile = MidiConverter.sequencerToMidi(
        this.notes,
        this.beats,
        this.bpm,
        480 // Standard ticks per quarter note
      );
      
      // Write MIDI file
      const midiData = MidiWriter.write(midiFile);
      
      // Create download
      const blob = new Blob([new Uint8Array(midiData)], { type: 'audio/midi' });
      const url = URL.createObjectURL(blob);

      const filename = this.title || i18next.t('untitled');
      const link = document.createElement('a');
      link.href = url;
      link.download = `${filename}.mid`;
      link.click();
      URL.revokeObjectURL(url);
      console.log('MIDI file exported successfully');
    } catch (error) {
      console.error('Error exporting MIDI file:', error);
      alert('Error exporting MIDI file.');
    }
  }

  async exportWav() {
    const endOfTrack = this.getEndOfTrack();

    if (endOfTrack <= 0) {
      alert(i18next.t('export_error_no_data'));
      return;
    }

    const filename = this.title || i18next.t('untitled');

    // Create a simple modal/progress UI (mixing 0-90%, encode 90-100%)
    const createProgressModal = () => {
      const dialog = document.getElementById('dialog') as HTMLDialogElement;

      const label = document.createElement('div');
      label.textContent = i18next.t('export_wav_progress');

      const progress = document.createElement('progress');
      progress.max = 100;
      progress.value = 0;
      progress.style.width = '360px';

      const percent = document.createElement('div');
      percent.textContent = '0%';

      dialog.appendChild(label);
      dialog.appendChild(progress);
      dialog.appendChild(percent);
      dialog.showModal();

      return {
        update: (p: number) => {
          progress.value = Math.min(100, Math.max(0, p));
          percent.textContent = `${Math.round(p)}%`;
        },
        destroy: () => {
          dialog.close();
          dialog.textContent = '';
        }
      };
    };

    const modal = createProgressModal();

    // Render mix with progress callback (maps to 0-90%)
    const buffer = await this.audioManager.renderMixToAudioBuffer({
      notes: this.notes,
      beats: this.beats,
      filenames: this.filenames,
      files: this.files,
      bpm: this.bpm,
      bpms: this.bpms,
      playbackSpeed: this.playbackSpeed,
      duration: this.calculateDuration(),
      sampleRate: 44100,
      numChannels: 2
    }, (processed, total) => {
      const mixPct = (processed / total) * 100;
      modal.update(Math.min(90, mixPct * 0.9));
    });

    // Prepare channel data and spawn worker for WAV encoding (encode maps to 90-100%)
    const numChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const length = buffer.length;

    const channels: Float32Array[] = [];
    for (let i = 0; i < numChannels; i++) {
      // copy data into transferable Float32Array
      channels.push(new Float32Array(buffer.getChannelData(i)));
    }

    const worker = new Worker(new URL('./wav.worker.ts', import.meta.url), { type: 'module' });

    const onError = (msg: string) => {
      console.error('WAV worker error:', msg);
      modal.destroy();
      try { worker.terminate(); } catch {}
    };

    worker.onmessage = (ev) => {
      const data = ev.data;
      if (!data) return;
      if (data.type === 'progress') {
        const processed = data.processed || 0;
        const total = data.total || length;
        const encodePct = (processed / total);
        const overall = 90 + encodePct * 10;
        modal.update(overall);
      } else if (data.type === 'done') {
        const arrayBuffer = data.buffer as ArrayBuffer;
        const blob = new Blob([arrayBuffer], { type: 'audio/wav' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${filename}.wav`;
        a.click();
        URL.revokeObjectURL(url);

        modal.destroy();
        try { worker.terminate(); } catch {}
      } else if (data.type === 'error') {
        onError(data.message);
      }
    };

    // Transfer underlying ArrayBuffers of Float32Arrays to worker
    const transferList = channels.map(ch => ch.buffer as ArrayBuffer);
    worker.postMessage({
      type: 'encode', sampleRate, numChannels, length, bitsPerSample: 16, channels: transferList
    }, transferList);
  }
}

// Initialize the sequencer when the page loads
new Sequencer();