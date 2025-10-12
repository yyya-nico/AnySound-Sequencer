import localForage from 'localforage';
import i18next from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { filenameToName, dispatchPointerPressEvent, resetAnimation } from './utils';

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

interface Files {
  [key: string]: File | null;
}

interface AudioSample {
  buffer: AudioBuffer | null;
  type: 'sine' | 'file';
}

// Audio Manager Class
class AudioManager {
  private context: AudioContext;
  private masterGain: GainNode;
  private melodySamples: Map<number, AudioSample> = new Map();
  private melodyPitchShift: number = 0;
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
    for (let note = 21; note <= 108; note++) {
      this.melodySamples.set(note, { buffer: null, type: 'sine' });
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

  setMelodySample(file: File | null) {
    if (file) {
      this.loadAudioFile(file).then(buffer => {
        for (let note = 21; note <= 108; note++) {
          this.melodySamples.set(note, { buffer, type: 'file' });
        }
      });
    } else {
      // Reset to sine wave
      for (let note = 21; note <= 108; note++) {
        this.melodySamples.set(note, { buffer: null, type: 'sine' });
      }
    }
  }

  setMelodyPitchShift(pitchShift: number) {
    this.melodyPitchShift = pitchShift;
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
    const sample = this.melodySamples.get(note.pitch);
    if (!sample) return;

    const source = this.context.createBufferSource();
    const gain = this.context.createGain();

    const durationInSeconds = this.beatsToSeconds(note.length, bpm);

    if (sample.type === 'sine') {
      const frequency = this.midiToFrequency(note.pitch);
      source.buffer = this.createSineWave(frequency, durationInSeconds);
    } else {
      source.buffer = sample.buffer;
      source.playbackRate.value = this.midiToPercentage(note.pitch, this.melodyPitchShift);
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

    const sample = this.melodySamples.get(note.pitch);
    if (!sample) return;

    const source = this.context.createBufferSource();
    const gain = this.context.createGain();

    const durationInSeconds = this.beatsToSeconds(note.length, bpm);

    if (sample.type === 'sine') {
      const frequency = this.midiToFrequency(note.pitch);
      source.buffer = this.createSineWave(frequency, durationInSeconds);
    } else {
      source.buffer = sample.buffer;
      source.playbackRate.value = this.midiToPercentage(note.pitch, this.melodyPitchShift);
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
  private audioManager: AudioManager;
  private notes: Map<string, Note[]> = new Map(); // track -> notes
  private beats: Beat[] = [];
  private files: Files = {
    melody: null,
    beat1: null,
    beat2: null,
  };
  private currentTrack: number = 0;
  private bpm: number = 120;
  private playbackSpeed: number = 1; // 0.5x, 1x, 2x
  private defaultNoteLength: number = 1;
  private paused: boolean = true;
  private gridSize: number = 64; // 64 beats
  private loopTimeout: number | null = null;
  private animationId: number | null = null;
  private saveTimeout: number | null = null;
  private lastBpmChangeTime: number = 0;
  private lastBpmChangeBeat: number = 0;
  private currentBeat: number = 0;
  private playedNotes: Set<string> = new Set();
  private pointerDowned: boolean = false;
  private autoScroll: boolean = true;

  constructor() {
    this.audioManager = new AudioManager();

    // Initialize tracks
    for (let i = 0; i < 4; i++) {
      this.notes.set(i.toString(), []);
    }

    this.setupEventListeners();
    this.initializePianoRoll();
    this.initializeRhythmSection();
    this.setupNoteDragResize();
    this.setupTrackScrolling();
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
        const newBpm = (e.target as HTMLInputElement).valueAsNumber;

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

    // Audio file inputs
    const pitchShiftLabel = document.querySelector('.pitch-shift-label') as HTMLElement;
    ['melody', 'beat1', 'beat2'].forEach(track => {
      const fileInput = document.getElementById(`${track}-sound-input`) as HTMLInputElement;
      const fileText = document.querySelector(`#${track}-sound-input + .file-text`) as HTMLElement;
      const sineButton = document.getElementById(`back-to-sine-${track}`) as HTMLButtonElement;
      
      fileInput.addEventListener('change', () => {
        if (fileInput.files?.[0]) {
          this.files[track] = fileInput.files[0];
          fileText.dataset.i18n = '';
          fileText.textContent = filenameToName(this.files[track]!.name);
          
          // 正弦波ボタンを表示
          sineButton.hidden = false;
          
          if (track === 'melody') {
            pitchShiftLabel.hidden = false;
            this.audioManager.setMelodySample(this.files.melody);
          } else if (track === 'beat1') {
            this.audioManager.setBeatSample(0, this.files.beat1);
          } else if (track === 'beat2') {
            this.audioManager.setBeatSample(1, this.files.beat2);
          }
        }
      });

      sineButton?.addEventListener('click', () => {
        this.files[track] = null;
        fileInput.value = '';
        fileText.dataset.i18n = 'select_sound_source_file';
        fileText.textContent = i18next.t('select_sound_source_file');
        
        // 正弦波ボタンを非表示
        sineButton.hidden = true;
        
        if (track === 'melody') {
          pitchShiftLabel.hidden = true;
          this.audioManager.setMelodySample(null);
        } else if (track === 'beat1') {
          this.audioManager.setBeatSample(0, null);
        } else if (track === 'beat2') {
          this.audioManager.setBeatSample(1, null);
        }
      });
    });

    document.getElementById('melody-pitch-shift')?.addEventListener('input', (e) => {
      const pitchShift = (e.target as HTMLInputElement).valueAsNumber || 0;
      this.audioManager.setMelodyPitchShift(pitchShift);

      const noteId = `preview-pitch-shift-${Date.now()}`
      const note: Note = {
        id: noteId,
        pitch: 60, // C4にピッチシフトが反映される
        start: 0,
        length: this.defaultNoteLength,
        velocity: 100
      };
      this.audioManager.playNotePreview(note, this.bpm * this.playbackSpeed, noteId);
    });

    document.getElementById('clear-btn')?.addEventListener('click', () => {
      if (confirm(i18next.t('confirm_clear_all'))) {
        this.clearAll();
      }
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

  private initializePianoRoll() {
    const section = document.querySelector('.piano-roll-section') as HTMLElement;
    const pianoRoll = document.querySelector('.piano-roll-grid') as HTMLElement;

    if (!pianoRoll) return;

    document.getElementById('app')!.style.setProperty('--scrollbar-width', `${section.offsetHeight - section.clientHeight}px`);
    section.scrollTop = 20 * (12 * 2 + 2); // 2 octaves + extra space
    section.addEventListener('scroll', (e) => {
      if (this.pointerDowned) {
        this.autoScroll = false;
      }
      const target = e.target as HTMLElement;
      const scrollLeft = target.scrollLeft;
      document.querySelector('.rhythm-section')!.scrollTo({ left: scrollLeft });
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
      const pointerNotePosition = Math.floor(x / 20) / 2; // 20px per 0.5 beat
      const pointerNoteIndex = Math.floor(y / 20);
      const pointerMidiNote = 108 - pointerNoteIndex; // C8 at top
      const isPointerDown = e.type === 'pointerdown';
      if (isPointerDown) {
        firstPointer.notePos = pointerNotePosition;
        firstPointer.pitch = pointerMidiNote;
        isResizing = x > target.offsetLeft + target.offsetWidth - 10;
      }
      if (!isResizing && (firstPointer.notePos !== pointerNotePosition || firstPointer.pitch !== pointerMidiNote)) {
        shouldMove = true;
      }

      // 範囲外の音程は無視
      if (pointerMidiNote < 21 || pointerMidiNote > 108) {
        return;
      }

      // Prevent adding if note already exists at this pitch
      const trackNotes = this.getCurrentTrackNotes();
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
        }
      } else {
        const id = this.addNote(pointerMidiNote, pointerNotePosition, this.defaultNoteLength);
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
      const target = e.target as HTMLElement;
      const trackNotes = this.getCurrentTrackNotes();
      currentNote = trackNotes.find(note => note.id === target.dataset.noteId) || null;
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
      if (isDragging) {
        handlePointerOperation(e);
      }
    });

    document.addEventListener('pointerup', (e) => {
      if (!e.isPrimary || e.button !== 0) return; // 左クリックのみ
      if (!isDragging) {
        return;
      }
      isDragging = false;
      this.audioManager.stopAllPreviews();
    });

    const removeNoteByEvent = (e: MouseEvent | CustomEvent) => {
      const target = (e?.detail?.originalTarget as HTMLElement) || (e.target as HTMLElement);
      const noteId = target.dataset.noteId || null;
      if (noteId) {
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
    document.querySelector('.rhythm-section')?.addEventListener('scroll', (e) => {
      if (this.pointerDowned) {
        this.autoScroll = false;
      }
      const target = e.target as HTMLElement;
      const scrollLeft = target.scrollLeft;
      document.querySelector('.piano-roll-section')!.scrollTo({ left: scrollLeft });
    });
    document.querySelectorAll('.rhythm-grid').forEach((grid, trackIndex) => {
      // Create beats grid
      for (let i = 0; i < this.gridSize; i++) {
        const beatElement = document.createElement('div');
        beatElement.className = 'beat';
        beatElement.dataset.position = i.toString();
        beatElement.dataset.track = trackIndex.toString();

        beatElement.addEventListener('click', () => {
          this.toggleBeat(trackIndex, i);
        });

        grid.appendChild(beatElement);
      }
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
      if (target.classList.contains('note')) {
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
      if (target.classList.contains('note')) {
        const rect = target.getBoundingClientRect();
        const x = pointerEvent.clientX - rect.left;

        isResizable = x > rect.width - 10;
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
        const newNoteValue = Math.max(0.5, Math.floor((originalWidth + deltaX) / 20) / 2); // 20px per 0.5 beat
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

    melodyTrackList.addEventListener('wheel', (e: WheelEvent) => {
      e.preventDefault();
      const direction = e.deltaY > 0 ? 1 : -1;
      this.switchToNextTrack(direction);
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
    const savedNotes = await localForage.getItem<{ [key: string]: Note[] }>('notes');
    const savedBeats = await localForage.getItem<Beat[]>('beats');
    const savedBpm = await localForage.getItem<number>('bpm');
    const savedPlaybackSpeed = await localForage.getItem<number>('playbackSpeed');
    const savedAudioFiles = await localForage.getItem<Files>('audioFiles');
    const savedMelodyPitchShift = await localForage.getItem<number>('melodyPitchShift');

    if (savedNotes) {
      Object.keys(savedNotes).forEach(track => {
        this.notes.set(track, savedNotes[track]);
      });
    }

    if (savedBeats) {
      this.beats = savedBeats;
      // Render beats
      this.beats.forEach(beat => {
        document.querySelector(`[data-track="${beat.track}"] [data-position="${beat.position}"]`)?.classList.add('active');
      });
    }

    if (savedBpm) {
      this.bpm = savedBpm;
      const bpmSlider = document.getElementById('bpm-slider') as HTMLInputElement;
      const bpmValue = document.getElementById('bpm-value') as HTMLInputElement;
      if (bpmSlider) bpmSlider.value = this.bpm.toString();
      if (bpmValue) bpmValue.valueAsNumber = this.bpm;
    }

    if (savedPlaybackSpeed) {
      this.playbackSpeed = savedPlaybackSpeed;
      const speedSelect = document.getElementById('speed-select') as HTMLSelectElement;
      if (speedSelect) speedSelect.value = this.playbackSpeed.toString();
    }

    if (savedAudioFiles) {
      this.files = savedAudioFiles;
      if (this.files.melody) {
        const fileText = document.querySelector('#melody-sound-input + .file-text') as HTMLElement;
        const sineButton = document.getElementById('back-to-sine-melody') as HTMLButtonElement;
        const pitchShiftLabel = document.querySelector('.pitch-shift-label') as HTMLElement;
        fileText.dataset.i18n = '';
        fileText.textContent = filenameToName(this.files.melody.name);
        sineButton.hidden = false;
        pitchShiftLabel.hidden = false;
        this.audioManager.setMelodySample(this.files.melody);
      }
      if (this.files.beat1) {
        const fileText = document.querySelector('#beat1-sound-input + .file-text') as HTMLElement;
        const sineButton = document.getElementById('back-to-sine-beat1') as HTMLButtonElement;
        fileText.dataset.i18n = '';
        fileText.textContent = filenameToName(this.files.beat1.name);
        sineButton.hidden = false;
        this.audioManager.setBeatSample(0, this.files.beat1);
      }
      if (this.files.beat2) {
        const fileText = document.querySelector('#beat2-sound-input + .file-text') as HTMLElement;
        const sineButton = document.getElementById('back-to-sine-beat2') as HTMLButtonElement;
        fileText.dataset.i18n = '';
        fileText.textContent = filenameToName(this.files.beat2.name);
        sineButton.hidden = false;
        this.audioManager.setBeatSample(1, this.files.beat2);
      }
    }

    if (savedMelodyPitchShift !== null && !isNaN(savedMelodyPitchShift)) {
      this.audioManager.setMelodyPitchShift(savedMelodyPitchShift);
      const pitchShiftInput = document.getElementById('melody-pitch-shift') as HTMLInputElement;
      if (pitchShiftInput) pitchShiftInput.valueAsNumber = savedMelodyPitchShift;
    }

    this.renderCurrentTrack();
  }

  private saveData() {
    const notesToSave: { [key: string]: Note[] } = {};
    this.notes.forEach((trackNotes, track) => {
      notesToSave[track] = trackNotes;
    });

    localForage.setItem('notes', notesToSave);
    localForage.setItem('beats', this.beats);
    localForage.setItem('bpm', this.bpm);
    localForage.setItem('playbackSpeed', this.playbackSpeed);
    localForage.setItem('audioFiles', this.files);

    const melodyPitchShift = (document.getElementById('melody-pitch-shift') as HTMLInputElement).valueAsNumber;
    localForage.setItem('melodyPitchShift', melodyPitchShift);
  }

  private switchToNextTrack(direction: number) {
    const trackCount = 4;
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

    this.renderCurrentTrack();
  }

  private getCurrentTrackNotes(): Note[] {
    return this.notes.get(this.currentTrack.toString()) || [];
  }

  private setCurrentTrackNotes(notes: Note[]) {
    this.notes.set(this.currentTrack.toString(), notes);
  }

  private addNote(pitch: number, start: number, length: number) {
    const trackNotes = this.getCurrentTrackNotes();
    const noteId = `note-${Date.now()}-${Math.random()}`;

    const note: Note = {
      id: noteId,
      pitch,
      start,
      length,
      velocity: 100
    };

    trackNotes.push(note);
    this.setCurrentTrackNotes(trackNotes);

    this.renderNote(note);
    return noteId;
  }

  private moveNote(noteId: string, newStart: number, newPitch: number) {
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

    document.querySelector(`[data-note-id="${noteId}"]`)?.remove();
  }

  private clearAll() {
    this.stop();
    this.notes.forEach((_, track) => {
      this.notes.set(track, []);
    });
    this.beats = [];
    this.bpm = 120;
    this.playbackSpeed = 1;
    this.files = {
      melody: null,
      beat1: null,
      beat2: null
    };
    this.audioManager.setMelodySample(null);
    this.audioManager.setMelodyPitchShift(0);
    this.audioManager.setBeatSample(0, null);
    this.audioManager.setBeatSample(1, null);

    // Clear UI
    const pianoRollSection = document.querySelector('.piano-roll-section') as HTMLElement;
    if (pianoRollSection) pianoRollSection.dataset.track = '1'; 
    document.querySelectorAll('.note').forEach(note => note.remove());
    document.querySelectorAll('.beat.active').forEach(beat => beat.classList.remove('active'));
    const bpmSlider = document.getElementById('bpm-slider') as HTMLInputElement;
    const bpmValue = document.getElementById('bpm-value') as HTMLInputElement;
    if (bpmSlider) bpmSlider.value = this.bpm.toString();
    if (bpmValue) bpmValue.valueAsNumber = this.bpm;
    const speedSelect = document.getElementById('speed-select') as HTMLSelectElement;
    if (speedSelect) speedSelect.value = this.playbackSpeed.toString();
    const loopToggle = document.getElementById('loop-toggle') as HTMLInputElement;
    if (loopToggle) loopToggle.checked = true;
    ['melody', 'beat1', 'beat2'].forEach(track => {
      const soundInput = document.getElementById(`${track}-sound-input`) as HTMLInputElement;
      if (soundInput) {
        soundInput.value = '';
        const fileText = document.querySelector(`#${track}-sound-input + .file-text`) as HTMLElement;
        fileText.dataset.i18n = 'select_sound_source_file';
        fileText.textContent = i18next.t('select_sound_source_file');
        const sineButton = document.getElementById(`back-to-sine-${track}`) as HTMLButtonElement;
        if (sineButton) sineButton.hidden = true;
      }
    });
    const pitchShiftLabel = document.querySelector('.pitch-shift-label') as HTMLElement;
    if (pitchShiftLabel) pitchShiftLabel.hidden = true;
    const pitchShiftInput = document.getElementById('melody-pitch-shift') as HTMLInputElement;
    if (pitchShiftInput) pitchShiftInput.value = '';
    this.saveData();
  }

  private renderNote(note: Note) {
    const pianoRoll = document.querySelector('.piano-roll-grid');
    if (!pianoRoll) return;

    const noteElement = document.createElement('div');
    noteElement.className = 'note';
    noteElement.dataset.noteId = note.id;
    this.updateNoteMeta(noteElement, note);

    pianoRoll.appendChild(noteElement);
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

  private toggleBeat(track: number, position: number) {
    const existingBeatIndex = this.beats.findIndex(
      beat => beat.track === track && beat.position === position
    );

    if (existingBeatIndex >= 0) {
      // Remove beat
      this.beats.splice(existingBeatIndex, 1);
      document.querySelector(`[data-track="${track}"] [data-position="${position}"]`)?.classList.remove('active');
    } else {
      // Add beat
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
  }

  private renderCurrentTrack() {
    // Clear existing notes
    document.querySelectorAll('.note').forEach(note => note.remove());

    // Render notes for current track
    const trackNotes = this.getCurrentTrackNotes()
    trackNotes.forEach(note => this.renderNote(note));
  }

  private getEndOfTrack(): number {
    return Array.from(this.notes.values()).flat().map(n => n.start + n.length).reduce((a, b) => Math.max(a, b), 0);
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
        position: this.positionToSec(this.currentBeat)
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
    if (!this.paused) {
      this.loopTimeout && clearTimeout(this.loopTimeout);
    }
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
      // 現在のビート位置を時間ベースで計算
      const elapsedSinceLastBpmChange = (timeStamp - this.lastBpmChangeTime) / 1000;
      const beatsSinceLastBpmChange = elapsedSinceLastBpmChange * (this.bpm * this.playbackSpeed) / 60;
      this.currentBeat = this.lastBpmChangeBeat + beatsSinceLastBpmChange;
      
      // playbackPositionの位置を更新（1ビート = 40px）
      const positionInPixels = this.currentBeat * 40;
      playbackPosition.style.setProperty('--position', `${positionInPixels}px`);

      if (this.autoScroll) {
        playbackPosition.scrollIntoView({ block: 'nearest', inline: 'center' });
      } else if (this.currentBeat <= 0.2) {
        this.autoScroll = true;
      }
      this.animationId = requestAnimationFrame(playRendering);
    };
    this.animationId = requestAnimationFrame(playRendering);

    const playLoop = () => {
      if (this.paused) return;
    
      const now = performance.now();
      
      // 現在のビート位置を再計算
      const elapsedSinceLastBpmChange = (now - this.lastBpmChangeTime) / 1000;
      const beatsSinceLastBpmChange = elapsedSinceLastBpmChange * (this.bpm * this.playbackSpeed) / 60;
      this.currentBeat = this.lastBpmChangeBeat + beatsSinceLastBpmChange;

      // Play notes at current beat
      this.notes.forEach(trackNotes => {
        trackNotes.forEach(note => {
          if (note.start <= this.currentBeat && note.start + 0.1 > this.currentBeat && !this.playedNotes.has(note.id)) {
            this.audioManager.playNote(note, this.bpm * this.playbackSpeed);
            this.playedNotes.add(note.id);
          }
        });
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

      this.loopTimeout = setTimeout(playLoop, 1);
    };

    playLoop();
  }

  private pause() {
    this.paused = true;
    this.renderPlayButton();
    this.loopTimeout && clearTimeout(this.loopTimeout);
    this.animationId && cancelAnimationFrame(this.animationId);
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
    this.loopTimeout && clearTimeout(this.loopTimeout);
    this.animationId && cancelAnimationFrame(this.animationId);
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
}

// Initialize the sequencer when the page loads
new Sequencer();