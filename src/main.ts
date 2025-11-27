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
    const key = element.dataset.i18n;
    if (key) {
      if (element.title) {
        element.title = i18next.t(key);
      } else {
        element.innerText = i18next.t(key);
      }
    }
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

interface AudioSample {
  buffer: AudioBuffer | null;
  type: 'sine' | 'file';
}

// Audio Manager Class
class AudioManager {
  private context: AudioContext;
  private masterGain: GainNode;
  private melodySamples: Map<number, Map<number, AudioSample>> = new Map();
  private melodyPitchShifts: Map<number, number> = new Map();
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
    for (let track = 0; track < 16; track++) {
      this.melodySamples.set(track, new Map());
      for (let note = 21; note <= 108; note++) {
        this.melodySamples.get(track)?.set(note, { buffer: null, type: 'sine' });
      }
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

  async loadAudioFile(file: File): Promise<AudioBuffer> {
    const arrayBuffer = await file.arrayBuffer();
    return this.context.decodeAudioData(arrayBuffer);
  }

  setMelodySample(track: number, file: File | null) {
    if (file) {
      this.loadAudioFile(file).then(buffer => {
        for (let note = 21; note <= 108; note++) {
          this.melodySamples.get(track)?.set(note, { buffer, type: 'file' });
        }
      });
    } else {
      // Reset to sine wave
      for (let note = 21; note <= 108; note++) {
        this.melodySamples.get(track)?.set(note, { buffer: null, type: 'sine' });
      }
    }
  }

  setMelodyPitchShift(track: number, pitchShift: number) {
    this.melodyPitchShifts.set(track, pitchShift);
  }

  setBeatSample(track: number, file: File | null) {
    if (file) {
      this.loadAudioFile(file).then(buffer => {
        this.beatSamples.set(track, { buffer, type: 'file' });
      });
    } else {
      // Reset to sine wave
      this.beatSamples.set(track, { buffer: null, type: 'sine' });
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

  playNote(note: Note, bpm: number, when: number = 0) {
    const sample = this.melodySamples.get(note.track)?.get(note.pitch);
    if (!sample) return;

    const source = this.context.createBufferSource();
    const gain = this.context.createGain();

    const durationInSeconds = this.beatsToSeconds(note.length, bpm);

    if (sample.type === 'sine') {
      const frequency = this.midiToFrequency(note.pitch);
      source.buffer = this.createSineWave(frequency, durationInSeconds);
    } else {
      source.buffer = sample.buffer;
      source.playbackRate.value = this.midiToPercentage(note.pitch, this.melodyPitchShifts.get(note.track) || 0);
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
  playNotePreview(note: Note, bpm: number, previewId: string, when: number = 0) {
    // 前のプレビュー音を停止
    this.stopPreview(previewId);

    const sample = this.melodySamples.get(note.track)?.get(note.pitch);
    if (!sample) return;

    const source = this.context.createBufferSource();
    const gain = this.context.createGain();

    const durationInSeconds = this.beatsToSeconds(note.length, bpm);

    if (sample.type === 'sine') {
      const frequency = this.midiToFrequency(note.pitch);
      source.buffer = this.createSineWave(frequency, durationInSeconds);
    } else {
      source.buffer = sample.buffer;
      source.playbackRate.value = this.midiToPercentage(note.pitch, this.melodyPitchShifts.get(note.track) || 0);
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
  private notes: Note[] = [];
  private beats: Beat[] = [];
  private files: AudioFile[] = [];
  private filenames: Filenames = {
    melody: new Map(),
    beat1: null,
    beat2: null
  };
  private currentTrack: number = 0;
  private bpm: number = 120;
  private playbackSpeed: number = 1; // 0.5x, 1x, 2x
  private quantization: number = 0.5; // in beats
  private defaultNoteLength: number = 1;
  private paused: boolean = true;
  private gridSize: number = 64; // 64 beats
  private visibleNoteElements: Map<string, HTMLElement> = new Map(); // noteId -> element
  private saveTimeout: number | null = null;
  private lastBpmChangeTime: number = 0;
  private lastBpmChangeBeat: number = 0;
  private currentBeat: number = 0;
  private playedNotes: Set<string> = new Set();
  private pointerDowned: boolean = false;
  private autoScroll: boolean = true;
  private selectedNotes: Set<string> = new Set();
  private isRectangleSelecting: boolean = false;
  private selectionStartX: number = 0;
  private selectionStartY: number = 0;

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
    sequencerContainer.addEventListener('pointerdown', () => {
      this.pointerDowned = true;
    });
    sequencerContainer.addEventListener('pointerup', (e) => {
      if (!e.isPrimary || e.button !== 0) return;
      this.pointerDowned = false;
    });
    sequencerContainer.addEventListener('touchstart', (e) => { // 複数指で拡大縮小が出来てしまうのを防ぐ
      if (e.touches.length > 1) {
        e.preventDefault();
      }
    }, { passive: false });
    // sequencerContainer.addEventListener('touchmove', (e) => {
    //   if (e.touches.length === 1) { // 1本目の指は無視
    //     e.preventDefault();
    //   }
    // }, { passive: false });
    let lastTouch = 0;
    sequencerContainer.addEventListener('touchend', (e) => { // ダブルタップズームを防ぐ
      const now = window.performance.now();
      if (now - lastTouch <= 500) {
        e.preventDefault();
      }
      lastTouch = now;
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
          this.updateBpmDuringPlayback();
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
      if (!menuContent.contains(e.target as Node) && e.target !== menuBtn) {
        menu.classList.remove('is-open');
      }
    });
    const speedSelect = document.getElementById('speed-select') as HTMLSelectElement;
    speedSelect?.addEventListener('change', (e) => {
      const newPlaybackSpeed = parseFloat((e.target as HTMLSelectElement).value);
      
      // 再生中の場合、現在のビート位置を記録してから再生速度を変更
      if (!this.paused) {
        this.updateBpmDuringPlayback();
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
      const soundSelect = container.querySelector('.sound-select') as HTMLSelectElement;
      const selectAudioFile = () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'audio/*';
        const promise = new Promise<File | null>((resolve) => {
          input.onchange = (event) => {
            const file = (event.target as HTMLInputElement).files?.[0] || null;
            if (!file) {
              resolve(null);
            }
            resolve(file);
          };
          input.oncancel = () => {
            resolve(null);
          };
        });
        input.click();
        return promise;
      }
      soundSelect.addEventListener('change', (e) => {
        const value = (e.target as HTMLSelectElement).value;
        if (value === 'add-sound') {
          // 新しい音源ファイルを追加
          selectAudioFile().then(file => {
            if (!file) {
              // キャンセルされた場合は選択を戻す
              if (track === 'melody') {
                soundSelect.value = this.filenames.melody.get(this.currentTrack) || 'sine';
              } else if (track === 'beat1') {
                soundSelect.value = this.filenames.beat1 || 'sine';
              } else if (track === 'beat2') {
                soundSelect.value = this.filenames.beat2 || 'sine';
              }
              return;
            }
            this.addAudioFile(file);
            this.setAudio(track, file.name);
          });
        } else if (value === 'sine') {
          // 正弦波を選択
          this.setSine(track);
        } else {
          // 既存の音源ファイルを選択
          const filename = value;
          this.setAudio(track, filename);
        }
      });
    });

    document.getElementById('melody-pitch-shift')?.addEventListener('input', (e) => {
      const pitchShift = (e.target as HTMLInputElement).valueAsNumber || 0;
      const audioFile = this.getAudioFileByTrack('melody');
      if (audioFile) {
        audioFile.pitchShift = pitchShift;
      }
      this.audioManager.setMelodyPitchShift(this.currentTrack, pitchShift);

      const noteId = `preview-pitch-shift-${Date.now()}`
      const note: Note = {
        id: noteId,
        track: this.currentTrack,
        pitch: 60, // C4にピッチシフトが反映される
        start: 0,
        length: this.defaultNoteLength,
        velocity: 100
      };
      this.audioManager.playNotePreview(note, this.bpm * this.playbackSpeed, noteId);
    });

    document.getElementById('clear-sounds-btn')?.addEventListener('click', () => {
      if (confirm(i18next.t('confirm_clear_sounds'))) {
        this.clearSounds();
      }
    });

    document.getElementById('clear-all-btn')?.addEventListener('click', () => {
      if (confirm(i18next.t('confirm_clear_all'))) {
        this.clearAll();
      }
    });

    // MIDI import/export
    document.getElementById('import-midi-btn')?.addEventListener('click', () => {
      this.importMidi();
    });

    document.getElementById('export-midi-btn')?.addEventListener('click', () => {
      this.exportMidi();
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
        
        const files = Array.from(e.dataTransfer!.files);
        if (files.length === 0) return;

        const file = files[0];
        this.handleFileDrop(file, dropZone);
      });
    });
  }

  private handleFileDrop(file: File, dropZone: HTMLElement) {
    const fileExtension = file.name.toLowerCase().split('.').pop();
    const isMidiFile = file.type === 'audio/midi' || file.type === 'audio/x-midi' || fileExtension === 'mid' || fileExtension === 'midi';
    const isAudioFile = file.type.startsWith('audio/') || 
      ['mp3', 'wav', 'ogg', 'aac', 'm4a', 'flac'].includes(fileExtension || '');

    if (isMidiFile) {
      this.importMidiFromFile(file);
    } else if (isAudioFile) {
      this.addAudioFile(file);
      const trackType = this.getTrackTypeFromDropZone(dropZone);
      if (trackType) {
        this.setAudio(trackType, file.name);
      }
    } else {
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

  private addAudioFile(file: File) {
    // すでに同じ名前のファイルがある場合は追加しない
    if (this.files.find(f => f.file.name === file.name)) {
      return;
    }
    this.files.push({ file, pitchShift: 0 });

    // すべてのサウンドセレクトにオプションを追加
    const soundSelects = document.querySelectorAll('.sound-select') as NodeListOf<HTMLSelectElement>;
    soundSelects.forEach(soundSelect => {
      const option = document.createElement('option');
      option.value = file.name;
      option.text = filenameToName(file.name);
      const selectHrElement = soundSelect.querySelector('hr');
      if (selectHrElement) {
        soundSelect.insertBefore(option, selectHrElement);
      }
    });
  }

  private getAudioFileByTrack(track: string): AudioFile | null {
    let filename: string | null = null;
    if (track === 'melody') {
      filename = this.filenames.melody.get(this.currentTrack) || null;
    } else if (track === 'beat1') {
      filename = this.filenames.beat1;
    } else if (track === 'beat2') {
      filename = this.filenames.beat2;
    }
    if (!filename) return null;
    const audioFile = this.files.find(f => f.file.name === filename) || null;
    return audioFile;
  }

  // private removeAudioFile(filename: string) {
  //   if (filename === 'sine' || filename === 'add-sound') return;
  //   const soundSelects = document.querySelectorAll('.sound-select') as NodeListOf<HTMLSelectElement>;
  //   soundSelects.forEach(soundSelect => {
  //     // 指定のオプションを削除
  //     const optionToRemove = Array.from(soundSelect.options).find(opt => opt.value === filename);
  //     if (optionToRemove) {
  //       optionToRemove.remove();
  //     }
  //   });

  //   // ファイルリストから削除
  //   this.files = this.files.filter(f => f.file.name !== filename);
    
  //   this.filenames.melody.forEach((name, track) => {
  //     if (name === filename) {
  //       if (track === this.currentTrack) {
  //         this.setSine('melody');
  //       } else {
  //         this.filenames.melody.set(track, 'sine');
  //       }
  //     }
  //   });
  //   if (this.filenames.beat1 === filename) {
  //     this.setSine('beat1');
  //   }
  //   if (this.filenames.beat2 === filename) {
  //     this.setSine('beat2');
  //   }
  // }

  private setAudio(track: string, filename: string = 'sine') {
    const soundButtonsContainer = document.querySelector(`.sound[data-track="${track}"]`) as HTMLElement;
    const pitchShiftLabel = document.querySelector('.pitch-shift-label') as HTMLElement;
    const soundSelect = soundButtonsContainer.querySelector('.sound-select') as HTMLSelectElement;
    const isSine = filename === 'sine';
    
    // Select要素の選択を更新
    soundSelect.value = filename;

    const file = (() => {
      if (isSine) return null;
      return this.files.find(f => f.file.name === filename)?.file || null;
    })();
    
    if (track === 'melody') {
      this.filenames.melody.set(this.currentTrack, filename);
      pitchShiftLabel.hidden = isSine;
      this.audioManager.setMelodySample(this.currentTrack, file);
    } else if (track === 'beat1') {
      this.filenames.beat1 = filename;
      this.audioManager.setBeatSample(0, file);
    } else if (track === 'beat2') {
      this.filenames.beat2 = filename;
      this.audioManager.setBeatSample(1, file);
    }
  }

  private setSine(track: string) {
    this.setAudio(track);
  }

  private initializePianoRoll() {
    const section = document.querySelector('.piano-roll-section') as HTMLElement;
    const pianoRoll = document.querySelector('.piano-roll-grid') as HTMLElement;

    if (!pianoRoll) return;

    document.getElementById('app')!.style.setProperty('--scrollbar-width', `${section.offsetHeight - section.clientHeight}px`);
    section.scrollTop = Sequencer.noteHeight * (12 * 2 + 2); // 2 octaves + extra space
    let beforeScrollLeft = 0, beforeScrollTop = section.scrollTop;
    section.addEventListener('scroll', (e) => {
      if (this.pointerDowned) {
        this.autoScroll = false;
      }
      const target = e.target as HTMLElement;
      const scrollLeft = target.scrollLeft;
      const scrollTop = target.scrollTop;
      document.querySelector('.rhythm-section')!.scrollTo({ left: scrollLeft });
      if (Math.abs(scrollLeft - beforeScrollLeft) > Sequencer.noteWidth || Math.abs(scrollTop - beforeScrollTop) > Sequencer.noteHeight) {
        beforeScrollLeft = scrollLeft;
        beforeScrollTop = scrollTop;
        this.renderTracks();
      }
    });

    section.addEventListener('animationend', () => {
      section.classList.remove('notify');
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
      this.audioManager.playNotePreview(currentNote, this.bpm * this.playbackSpeed, currentPreviewId);
    };

    pianoRoll.addEventListener('pointerdown', (e) => {
      if (!e.isPrimary || e.button !== 0) return; // 左クリックのみ
      
      // Altキーが押されている場合は矩形選択開始
      if (e.altKey) {
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
      
      if (this.isRectangleSelecting) {
        this.updateSelectionBox(e, pianoRoll);
      } else if (isDragging) {
        handlePointerOperation(e);
      }
    });

    document.addEventListener('pointerup', (e) => {
      if (!e.isPrimary || e.button !== 0) return; // 左クリックのみ
      
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

    playbackPosition.addEventListener('pointerdown', (e) => {
      if (!e.isPrimary || e.button !== 0) return; // 左クリックのみ
      beforePaused = this.paused;
      if (!this.paused) this.pause();
      playbackDragging = true;
      
      const pianoRollRect = pianoRoll.getBoundingClientRect();
      initialRelativeX = e.clientX - pianoRollRect.left; // pianoRoll内での相対X座標
      beforePos = parseFloat(playbackPosition.style.getPropertyValue('--position')) || 0;
      pianoRoll.classList.add('playback-drag');
    });
    
    [playbackPosition, pianoRoll].forEach(element => {
      element.addEventListener('pointermove', (e) => {
        if (!playbackDragging) return;
        
        const pianoRollRect = pianoRoll.getBoundingClientRect();
        const currentRelativeX = e.clientX - pianoRollRect.left;
        const deltaX = currentRelativeX - initialRelativeX;
        
        const newPosition = minmax(beforePos + deltaX, 0, this.gridSize * Sequencer.noteWidth);
        playbackPosition.style.setProperty('--position', `${newPosition}px`);
        const newBeat = newPosition / Sequencer.noteWidth;
        this.currentBeat = newBeat;

        // Play notes at current beat
        this.notes.forEach(note => {
          if (note.start <= this.currentBeat && note.start + 0.1 > this.currentBeat && !this.playedNotes.has(note.id)) {
            this.audioManager.playNote(note, this.bpm * this.playbackSpeed);
          }
        });

        // Play beats at current beat
        this.beats.forEach(beat => {
          if (beat.position <= this.currentBeat && beat.position + 0.1 > this.currentBeat && !this.playedNotes.has(beat.id)) {
            this.audioManager.playBeat(beat);
          }
        });

        this.scrollByDragging(e, true);
      });
    });
    document.addEventListener('pointerup', (e) => {
      if (!playbackDragging || !e.isPrimary || e.button !== 0) return;
      if (!beforePaused) this.play();
      playbackDragging = false;
      playbackPosition.classList.remove('hover');
      pianoRoll.classList.remove('playback-drag');
    });
  }

  private initializeRhythmSection() {
    const section = document.querySelector('.rhythm-section') as HTMLElement;
    section.addEventListener('scroll', (e) => {
      if (this.pointerDowned) {
        this.autoScroll = false;
      }
      const target = e.target as HTMLElement;
      const scrollLeft = target.scrollLeft;
      document.querySelector('.piano-roll-section')!.scrollTo({ left: scrollLeft });
    });
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
    const melodyTrackList = document.getElementById('track-selector');
    if (!melodyTrackList) return;

    let moveStrage = 0;
    melodyTrackList.addEventListener('wheel', (e: WheelEvent) => {
      e.preventDefault();
      moveStrage += e.deltaY;
      console.log(e.deltaY, moveStrage);
      if (Math.abs(moveStrage) < 20) return;
      const direction = moveStrage > 0 ? 1 : -1;
      this.switchToNextTrack(direction);
      moveStrage = 0;
    });

    let isPointerDown = false;
    let beforeY = 0;
    melodyTrackList.addEventListener('pointerdown', (e: PointerEvent) => {
      if (!e.isPrimary || e.button !== 0) return; // 左クリックのみ
      isPointerDown = true;
      beforeY = e.clientY;
    });

    let captured = false;
    melodyTrackList.addEventListener('pointermove', (e: PointerEvent) => {
      if (!isPointerDown) return;
      if (!captured) {
        melodyTrackList.setPointerCapture(e.pointerId);
        captured = true;
      }
      const y = e.clientY;
      const distance = y - beforeY;

      if (Math.abs(distance) > 40) {
        const direction = distance > 0 ? 1 : -1;
        this.switchToNextTrack(direction);
        beforeY = y;
      }
    });

    melodyTrackList.addEventListener('pointerup', (e: PointerEvent) => {
      if (!e.isPrimary || e.button !== 0) return; // 左クリックのみ
      isPointerDown = false;
      melodyTrackList.releasePointerCapture(e.pointerId);
      captured = false;
    });

    melodyTrackList.addEventListener('pointerleave', () => {
      isPointerDown = false;
    });
  }

  private async setupLocalForage() {
    localForage.config({
      name: 'AnySoundSequencer',
      storeName: 'sequencer_data'
    });

    // Load saved data
    const savedNotes = await localForage.getItem<Note[]>('notes');
    const savedBeats = await localForage.getItem<Beat[]>('beats');
    const savedBpm = await localForage.getItem<number>('bpm');
    const savedPlaybackSpeed = await localForage.getItem<number>('playbackSpeed');
    const savedQuantization = await localForage.getItem<number>('quantization');
    const savedAudioFiles = await localForage.getItem<AudioFile[]>('audioFiles');
    const savedAudioFilenames = await localForage.getItem<Filenames>('audioFilenames');
    const savedGridSize = await localForage.getItem<number>('gridSize');

    if (savedGridSize) {
      this.gridSize = savedGridSize;
      (document.querySelector('.sequencer-container') as HTMLElement).style.setProperty('--grid-size', this.gridSize.toString());
    }

    if (savedNotes) {
      this.notes = savedNotes;
      // Render notes (will be re-rendered in renderCurrentTrack)
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

    if (savedAudioFiles) {
      if (!Array.isArray(savedAudioFiles)) {
        console.error('Saved audio files data is corrupted.');
        return;
      }
      this.files = savedAudioFiles;

      // すべてのサウンドセレクトにオプションを追加
      const soundSelects = document.querySelectorAll('.sound-select') as NodeListOf<HTMLSelectElement>;
      soundSelects.forEach(soundSelect => {
        this.files.forEach(({ file }) => {
          const option = document.createElement('option');
          option.value = file.name;
          option.text = filenameToName(file.name);
          const selectHrElement = soundSelect.querySelector('hr');
          if (selectHrElement) {
            soundSelect.insertBefore(option, selectHrElement);
          }
        });
      });
      if (savedAudioFilenames) {
        this.filenames = savedAudioFilenames;
        Object.entries(savedAudioFilenames).forEach(([track, value]) => {
          if (track === 'melody') {
            const filenames = value as Map<number, string>;
            filenames.forEach((filename, track) => {
              const audioFile = this.files.find(f => f.file.name === filename) || null;
              if (audioFile) {
                this.audioManager.setMelodySample(track, audioFile.file);
                this.audioManager.setMelodyPitchShift(track, audioFile.pitchShift);
                if (track === this.currentTrack && audioFile.pitchShift) {      
                  const pitchShiftInput = document.getElementById('melody-pitch-shift') as HTMLInputElement;
                  if (pitchShiftInput) pitchShiftInput.valueAsNumber = audioFile.pitchShift;
                }
              }
            });
            const container = document.querySelector(`.sound[data-track="melody"]`) as HTMLElement;
            const soundSelect = container.querySelector('.sound-select') as HTMLSelectElement;
            const currentFilename = filenames.get(this.currentTrack) || 'sine';
            soundSelect.value = currentFilename;
            const isSine = currentFilename === 'sine';
            const pitchShiftLabel = document.querySelector('.pitch-shift-label') as HTMLElement;
            pitchShiftLabel.hidden = isSine;
          } else if (track === 'beat1') {
            const filename = value as string;
            const file = this.files.find(f => f.file.name === filename)?.file || null;
            if (file) {
              this.audioManager.setBeatSample(0, file);
            }
            const container = document.querySelector(`.sound[data-track="beat1"]`) as HTMLElement;
            const soundSelect = container.querySelector('.sound-select') as HTMLSelectElement;
            soundSelect.value = filename;
          } else if (track === 'beat2') {
            const filename = value as string;
            const file = this.files.find(f => f.file.name === filename)?.file || null;
            if (file) {
              this.audioManager.setBeatSample(1, file);
            }
            const container = document.querySelector(`.sound[data-track="beat2"]`) as HTMLElement;
            const soundSelect = container.querySelector('.sound-select') as HTMLSelectElement;
            soundSelect.value = filename;
          }
        });
      }
    }

    this.renderTracks();
  }

  private updateViewPort() {
    const section = document.querySelector('.piano-roll-section') as HTMLElement;
    
    // 現在の表示範囲を計算
    const scrollLeft = section.scrollLeft;
    const scrollTop = section.scrollTop;
    const viewWidth = section.clientWidth;
    const viewHeight = section.clientHeight;
    
    // ビート範囲（少し余裕を持たせる）
    const soundPanelWidth = 180; // CSS変数から取得
    const adjustedLeft = Math.max(0, scrollLeft - soundPanelWidth);
    this.viewPort.startBeat = Math.max(0, Math.floor(adjustedLeft / Sequencer.noteWidth) - 2);
    this.viewPort.endBeat = Math.ceil((adjustedLeft + viewWidth) / Sequencer.noteWidth) + 2;

    // ピッチ範囲
    this.viewPort.startPitch = 108 - Math.max(0, Math.floor(scrollTop / Sequencer.noteHeight) - 2);
    this.viewPort.endPitch = 108 - Math.min(127, Math.ceil((scrollTop + viewHeight) / Sequencer.noteHeight) + 2);
  }

  private isNoteVisible(note: Note): boolean {
    return note.start + note.length > this.viewPort.startBeat! &&
           note.start < this.viewPort.endBeat! &&          
           note.pitch <= this.viewPort.startPitch! &&
           note.pitch >= this.viewPort.endPitch!;
  }

  private scrollByDragging(e: PointerEvent, horizontalOnly: boolean = false) {
    const section = document.querySelector('.piano-roll-section') as HTMLElement;
    if (!section) return;

    const sectionRect = section.getBoundingClientRect();
    const x = e.clientX - sectionRect.left, y = e.clientY - sectionRect.top;
    const edgeThreshold = 50;

    if (!horizontalOnly && y > sectionRect.height - edgeThreshold) {
      section.scrollBy({ top: 20 });
    }
    if (x > sectionRect.width - edgeThreshold) {
      section.scrollBy({ left: 20 });
    }
    if (!horizontalOnly && y < edgeThreshold) {
      section.scrollBy({ top: -20 });
    }
    if (x < edgeThreshold) {
      section.scrollBy({ left: -20 });
    }
  }

  private saveData() {
    localForage.setItem('notes', this.notes);
    localForage.setItem('beats', this.beats);
    localForage.setItem('bpm', this.bpm);
    localForage.setItem('playbackSpeed', this.playbackSpeed);
    localForage.setItem('quantization', this.quantization);
    localForage.setItem('audioFiles', this.files);
    localForage.setItem('audioFilenames', this.filenames);
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
    const pitchShiftLabel = document.querySelector('.pitch-shift-label') as HTMLElement;
    const soundSelect = melodySoundButtonsContainer.querySelector('.sound-select') as HTMLSelectElement;

    const filename = this.filenames.melody.get(this.currentTrack) || 'sine';
    const isSine = filename === 'sine';
    soundSelect.value = filename;
    pitchShiftLabel.hidden = isSine;
    const audioFile = this.files.find(f => f.file.name === filename) || null;
    if (audioFile) {
      const pitchShiftInput = document.getElementById('melody-pitch-shift') as HTMLInputElement;
      if (pitchShiftInput) pitchShiftInput.valueAsNumber = audioFile.pitchShift;
    }
    
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
    this.files = [];
    this.filenames = {
      melody: new Map<number, string>(),
      beat1: null,
      beat2: null
    };
    for (let i = 0; i < 16; i++) {
      this.audioManager.setMelodySample(i, null);
      this.audioManager.setMelodyPitchShift(i, 0);
    }
    this.audioManager.setBeatSample(0, null);
    this.audioManager.setBeatSample(1, null);

    const soundButtonsContainers = document.querySelectorAll('.sound');
    soundButtonsContainers.forEach(container => {
      const soundSelect = container.querySelector('.sound-select') as HTMLSelectElement;
      // Select要素から追加されたオプションを削除
      Array.from(soundSelect.options).forEach(option => {
        if (option.value !== 'sine' && option.value !== 'add-sound') {
          option.remove();
        }
      });
      soundSelect.value = 'sine';
    });
    const pitchShiftLabel = document.querySelector('.pitch-shift-label') as HTMLElement;
    if (pitchShiftLabel) pitchShiftLabel.hidden = true;
    const pitchShiftInput = document.getElementById('melody-pitch-shift') as HTMLInputElement;
    if (pitchShiftInput) pitchShiftInput.value = '';
  }

  private clearAll() {
    this.stop();
    this.notes = [];
    this.beats = [];
    this.bpm = 120;
    this.playbackSpeed = 1;
    this.gridSize = 64;

    // Clear UI
    const sequencerContainer = document.querySelector('.sequencer-container') as HTMLElement;
    if (sequencerContainer) sequencerContainer.style.setProperty('--grid-size', this.gridSize.toString());
    const pianoRollSection = document.querySelector('.piano-roll-section') as HTMLElement;
    if (pianoRollSection) pianoRollSection.dataset.track = '1'; 
    document.querySelectorAll('.note').forEach(note => note.remove());
    document.querySelectorAll('.beat').forEach(beat => beat.remove());
    this.createBeats();
    this.beats.forEach(beat => this.renderBeat(beat));
    const bpmSlider = document.getElementById('bpm-slider') as HTMLInputElement;
    const bpmValue = document.getElementById('bpm-value') as HTMLInputElement;
    if (bpmSlider) bpmSlider.valueAsNumber = this.bpm;
    if (bpmValue) bpmValue.valueAsNumber = this.bpm;
    const speedSelect = document.getElementById('speed-select') as HTMLSelectElement;
    if (speedSelect) speedSelect.value = this.playbackSpeed.toString();
    const loopToggle = document.getElementById('loop-toggle') as HTMLInputElement;
    if (loopToggle) loopToggle.checked = true;
    this.clearSounds();
    document.querySelector('.menu')?.classList.remove('is-open');
    this.saveData();
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
    
    // 既存の選択をクリア（Ctrlキーが押されていない場合）
    if (!e.ctrlKey) {
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
          this.audioManager.playNotePreview(firstNoteData.note, this.bpm * this.playbackSpeed, movePreviewId);
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

  private positionToSec(beat: number): number {
    return beat * 60 / (this.bpm * this.playbackSpeed);
  }

  private updateBpmDuringPlayback() {
    if (this.paused) return;
    
    // 現在のビート位置を計算
    const now = performance.now();
    const elapsedSinceLastBpmChange = (now - this.lastBpmChangeTime) / 1000;
    const beatsSinceLastBpmChange = elapsedSinceLastBpmChange * (this.bpm * this.playbackSpeed) / 60;
    this.currentBeat = this.lastBpmChangeBeat + beatsSinceLastBpmChange;
    
    // 新しいBPMでの基準点を更新
    this.lastBpmChangeTime = now;
    this.lastBpmChangeBeat = this.currentBeat;

    // Update Media Session position state
    if ('mediaSession' in navigator) {
      navigator.mediaSession.setPositionState({
        duration: this.positionToSec(this.getEndOfTrack()),
        position: this.positionToSec(Math.min(this.currentBeat, this.getEndOfTrack()))
      });
    }
  }

  private resetPlayback() {
    this.lastBpmChangeTime = performance.now();
    this.lastBpmChangeBeat = 0;
    this.currentBeat = 0;
    this.playedNotes.clear();
    const pianoRollSection = document.querySelector('.piano-roll-section') as HTMLElement;
    const playbackPosition = document.querySelector('.playback-position') as HTMLElement;
    pianoRollSection.scrollTo({ left: 0 });
    playbackPosition.style.removeProperty('--position');
    if ('mediaSession' in navigator) {
      navigator.mediaSession.setPositionState({
        duration: this.positionToSec(this.getEndOfTrack()),
        position: 0,
      });
    }
  }

  private async play() {
    if (this.currentBeat >= this.getEndOfTrack()) {
      this.resetPlayback();
    }

    await this.audioManager.resume();
    this.paused = false;
    this.autoScroll = true;
    this.renderPlayButton();
    const sequencerContainer = document.querySelector('.sequencer-container') as HTMLElement;
    const playbackPosition = document.querySelector('.playback-position') as HTMLElement;
    sequencerContainer.classList.add('playing');
    sequencerContainer.classList.remove('paused');

    this.lastBpmChangeTime = performance.now();
    this.lastBpmChangeBeat = this.currentBeat;    

    // Update Media Session metadata
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'playing';
      navigator.mediaSession.setPositionState({
        duration: this.positionToSec(this.getEndOfTrack()),
        position: this.positionToSec(this.currentBeat)
      });
    }

    const playRendering = (timeStamp: number) => {
      if (this.paused) return;
      requestAnimationFrame(playRendering);
      // 現在のビート位置を時間ベースで計算
      const elapsedSinceLastBpmChange = (timeStamp - this.lastBpmChangeTime) / 1000;
      const beatsSinceLastBpmChange = elapsedSinceLastBpmChange * (this.bpm * this.playbackSpeed) / 60;
      this.currentBeat = this.lastBpmChangeBeat + beatsSinceLastBpmChange;
      
      // playbackPositionの位置を更新
      const positionInPixels = this.currentBeat * Sequencer.noteWidth;
      playbackPosition.style.setProperty('--position', `${positionInPixels}px`);

      if (this.autoScroll) {
        playbackPosition.scrollIntoView({ block: 'nearest', inline: 'center' });
      } else if (this.currentBeat <= 0.2) {
        this.autoScroll = true;
      }
    };
    requestAnimationFrame(playRendering);

    const playLoop = () => {
      if (this.paused) return;
      setTimeout(playLoop, 1);
    
      const now = performance.now();
      
      // 現在のビート位置を再計算
      const elapsedSinceLastBpmChange = (now - this.lastBpmChangeTime) / 1000;
      const beatsSinceLastBpmChange = elapsedSinceLastBpmChange * (this.bpm * this.playbackSpeed) / 60;
      this.currentBeat = this.lastBpmChangeBeat + beatsSinceLastBpmChange;

      // Play notes at current beat
      this.notes.forEach(note => {
        if (note.start <= this.currentBeat && note.start + 0.1 > this.currentBeat && !this.playedNotes.has(note.id)) {
          this.audioManager.playNote(note, this.bpm * this.playbackSpeed);
          this.playedNotes.add(note.id);
        }
      });

      // Play beats at current beat
      this.beats.forEach(beat => {
        if (beat.position <= this.currentBeat && beat.position + 0.1 > this.currentBeat && !this.playedNotes.has(beat.id)) {
          this.audioManager.playBeat(beat);
          this.playedNotes.add(beat.id);
        }
      });

      if (this.currentBeat >= this.getEndOfTrack()) {
        const loopToggle = document.getElementById('loop-toggle') as HTMLInputElement;
        if (!loopToggle.checked) {
          this.stop();
          return;
        }
        this.resetPlayback();
      }
    };

    playLoop();
  }

  private pause() {
    this.paused = true;
    this.renderPlayButton();
    this.playedNotes.clear();
    const sequencerContainer = document.querySelector('.sequencer-container') as HTMLElement;
    sequencerContainer.classList.remove('playing');
    sequencerContainer.classList.add('paused');
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'paused';
    }
  }

  private stop() {
    this.paused = true;
    this.renderPlayButton();
    this.playedNotes.clear();
    const sequencerContainer = document.querySelector('.sequencer-container') as HTMLElement;
    sequencerContainer.classList.remove('playing', 'paused');
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
      const sequencerData = MidiConverter.midiToSequencer(midiFile, this.bpm);
      
      // Clear existing data
      this.stop();
      this.notes = [];
      this.beats = [];
      
      // Load converted data
      this.notes = sequencerData.notes;
      this.beats = sequencerData.beats;
      this.bpm = sequencerData.bpm;
      this.gridSize = Math.max(64, sequencerData.gridSize);
      
      // Update UI
      const sequencerContainer = document.querySelector('.sequencer-container') as HTMLElement;
      const bpmSlider = document.getElementById('bpm-slider') as HTMLInputElement;
      const bpmValue = document.getElementById('bpm-value') as HTMLInputElement;
      if (sequencerContainer) {
        sequencerContainer.style.setProperty('--grid-size', this.gridSize.toString());
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
      
      console.log(`Imported MIDI file: ${file.name}`);
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

    document.querySelector('.menu')?.classList.remove('is-open');
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
      
      const link = document.createElement('a');
      link.href = url;
      link.download = `sequencer-export-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.mid`;
      link.click();
      URL.revokeObjectURL(url);
      console.log('MIDI file exported successfully');
    } catch (error) {
      console.error('Error exporting MIDI file:', error);
      alert('Error exporting MIDI file.');
    }

    document.querySelector('.menu')?.classList.remove('is-open');
  }
}

// Initialize the sequencer when the page loads
new Sequencer();