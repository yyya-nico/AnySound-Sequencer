import localForage from 'localforage';
import i18next from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

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
        element.textContent = i18next.t(key);
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

interface AudioSample {
  buffer: AudioBuffer | null;
  type: 'sine' | 'file';
}

// Audio Manager Class
class AudioManager {
  private context: AudioContext;
  private masterGain: GainNode;
  private melodySamples: Map<number, AudioSample> = new Map();
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

  private midiToPercentage(midiNote: number): number {
    return Math.pow(2, (midiNote - 53) / 12); // F3 as reference
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
      source.playbackRate.value = this.midiToPercentage(note.pitch);
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
      source.playbackRate.value = this.midiToPercentage(note.pitch);
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
  private currentTrack: number = 0;
  private bpm: number = 120;
  private defaultNoteLength: number = 1;
  private isPlaying: boolean = false;
  private currentBeat: number = 0;
  private gridSize: number = 64; // 64 beats
  private loopTimeout: number | null = null;
  private saveTimeout: number | null = null;

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
    document.getElementById('play-btn')?.addEventListener('click', () => {
      if (this.isPlaying) {
        this.stop();
      } else {
        this.play();
      }
    });

    document.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return; // 左クリックのみ
      window.clearTimeout(this.saveTimeout!);
    });

    document.addEventListener('pointerup', () => {
      this.saveTimeout = window.setTimeout(() => this.saveData(), 1000);
    });

    // BPM control
    const bpmSlider = document.getElementById('bpm-slider') as HTMLInputElement;
    const bpmValue = document.getElementById('bpm-value');
    bpmSlider?.addEventListener('input', (e) => {
      this.bpm = (e.target as HTMLInputElement).valueAsNumber;
      if (bpmValue) bpmValue.textContent = this.bpm.toString();
    });

    // Track selector
    document.querySelectorAll('.track-item').forEach((item, index) => {
      item.addEventListener('click', () => {
        this.switchTrack(index);
      });
    });

    // Audio file inputs
    document.getElementById('melody-sound-input')?.addEventListener('change', (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      this.audioManager.setMelodySample(file || null);
    });

    document.getElementById('use-sine-melody')?.addEventListener('click', () => {
      this.audioManager.setMelodySample(null);
      const input = document.getElementById('melody-sound-input') as HTMLInputElement;
      if (input) input.value = '';
    });

    document.getElementById('beat1-sound-input')?.addEventListener('change', (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      this.audioManager.setBeatSample(0, file || null);
    });

    document.getElementById('use-sine-beat1')?.addEventListener('click', () => {
      this.audioManager.setBeatSample(0, null);
      const input = document.getElementById('beat1-sound-input') as HTMLInputElement;
      if (input) input.value = '';
    });

    document.getElementById('beat2-sound-input')?.addEventListener('change', (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      this.audioManager.setBeatSample(1, file || null);
    });

    document.getElementById('use-sine-beat2')?.addEventListener('click', () => {
      this.audioManager.setBeatSample(1, null);
      const input = document.getElementById('beat2-sound-input') as HTMLInputElement;
      if (input) input.value = '';
    });

    document.getElementById('clear-btn')?.addEventListener('click', () => {
      if (confirm(i18next.t('confirm_clear_all'))) {
        this.clearAll();
      }
    });
  }

  private initializePianoRoll() {
    // const melodyKeys = document.querySelector('.melody-keys');
    const section = document.querySelector('.piano-roll-section') as HTMLElement;
    const pianoRoll = document.querySelector('.piano-roll-grid') as HTMLElement;

    if (/* !melodyKeys ||  */!pianoRoll) return;

    document.getElementById('app')!.style.setProperty('--scrollbar-width', `${section.offsetHeight - section.clientHeight}px`);
    section.scrollTop = 20 * (12 * 2 + 2); // 2 octaves + extra space
    section.addEventListener('scroll', (e) => {
      const target = e.target as HTMLElement;
      const scrollLeft = target.scrollLeft; 
      document.querySelector('.rhythm-section')!.scrollLeft = scrollLeft;
    });

    // // Create melody keys (C1 to C8, bottom to top)
    // for (let octave = 1; octave <= 8; octave++) {
    //   const notes = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    //   notes.forEach((noteName, index) => {
    //     const midiNote = (octave + 1) * 12 + index;
    //     if (midiNote > 108) return; // C8 is 108

    //     const keyElement = document.createElement('div');
    //     keyElement.className = `melody-key ${noteName.includes('#') ? 'black-key' : 'white-key'}`;
    //     keyElement.textContent = `${noteName}${octave}`;
    //     keyElement.dataset.note = midiNote.toString();

    //     keyElement.addEventListener('click', () => {
    //       this.audioManager.playNote({
    //         id: '',
    //         pitch: midiNote,
    //         start: 0,
    //         value: 0.5,
    //         velocity: 100
    //       });
    //     });

    //     melodyKeys.prepend(keyElement);
    //   });
    // }

    // // Create grid
    // const grid = document.createElement('div');
    // grid.className = 'grid';
    // pianoRoll.appendChild(grid);

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
      this.audioManager.playNotePreview(currentNote, this.bpm, currentPreviewId);
    };

    pianoRoll.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return; // 左クリックのみ
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
      if (isDragging) {
        handlePointerOperation(e);
      }
    });

    document.addEventListener('pointerup', () => {
      if (!isDragging) {
        return;
      }
      isDragging = false;
      this.audioManager.stopAllPreviews();
    });

    pianoRoll.addEventListener('dblclick', (e) => {
      const target = e.target as HTMLElement;
      const noteId = target.dataset.noteId || null;
      if (noteId) {
        this.removeNote(noteId);
      }
    });
  }

  private initializeRhythmSection() {
    document.querySelector('.rhythm-section')?.addEventListener('scroll', (e) => {
      const target = e.target as HTMLElement;
      const scrollLeft = target.scrollLeft;
      document.querySelector('.piano-roll-section')!.scrollLeft = scrollLeft;
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
      if (isResizable) {
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
    const controlPanel = document.querySelector('.control-panel');
    if (!controlPanel) return;

    // controlPanel.addEventListener('wheel', (e: Event) => {
    //   const wheelEvent = e as WheelEvent;
    //   e.preventDefault();
    //   const direction = wheelEvent.deltaY > 0 ? 1 : -1;
    //   this.switchToNextTrack(direction);
    // });

    // controlPanel.addEventListener('pointermove', (e: Event) => {
    //   const pointerEvent = e as PointerEvent;
    //   const rect = controlPanel.getBoundingClientRect();
    //   const y = pointerEvent.clientY - rect.top;
    //   const centerY = rect.height / 2;
    //   const distance = Math.abs(y - centerY);

    //   if (distance > 50) {
    //     const direction = y > centerY ? 1 : -1;
    //     this.switchToNextTrack(direction);
    //   }
    // });
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
      const bpmValue = document.getElementById('bpm-value');
      if (bpmSlider) bpmSlider.value = this.bpm.toString();
      if (bpmValue) bpmValue.textContent = this.bpm.toString();
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
  }

  private switchToNextTrack(direction: number) {
    const trackCount = 4;
    this.currentTrack = ((this.currentTrack + direction) + trackCount) % trackCount;

    // Update UI
    document.querySelector('.track-item.active')?.classList.remove('active');
    document.querySelector(`.track-item[data-track="${this.currentTrack}"]`)?.classList.add('active');

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
    this.notes.forEach((_, track) => {
      this.notes.set(track, []);
    });
    this.beats = [];
    this.bpm = 120;

    // Clear UI
    document.querySelectorAll('.note').forEach(note => note.remove());
    document.querySelectorAll('.beat.active').forEach(beat => beat.classList.remove('active'));
    const bpmSlider = document.getElementById('bpm-slider') as HTMLInputElement;
    const bpmValue = document.getElementById('bpm-value');
    if (bpmSlider) bpmSlider.value = this.bpm.toString();
    if (bpmValue) bpmValue.textContent = this.bpm.toString();
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

  private switchTrack(trackIndex: number) {
    // Update active track
    document.querySelector('.track-item.active')?.classList.remove('active');
    document.querySelector(`.track-item[data-track="${trackIndex}"]`)?.classList.add('active');

    this.currentTrack = trackIndex;
    this.renderCurrentTrack();
  }

  private renderCurrentTrack() {
    // Clear existing notes
    document.querySelectorAll('.note').forEach(note => note.remove());

    // Render notes for current track
    const trackNotes = this.getCurrentTrackNotes()
    trackNotes.forEach(note => this.renderNote(note));
  }

  private async play() {
    if (this.isPlaying) {
      this.loopTimeout && clearTimeout(this.loopTimeout);
    }

    await this.audioManager.resume();
    this.isPlaying = true;
    this.currentBeat = 0;
    this.renderPlayButton();

    const playLoop = () => {
      if (!this.isPlaying) return;

      const beatDuration = 60 / this.bpm / 2; // 8th note duration

      // Play notes at current beat
      this.notes.forEach(trackNotes => {
        trackNotes.forEach(note => {
          if (note.start === this.currentBeat) {
            this.audioManager.playNote(note, this.bpm);
          }
        });
      });

      // Play beats at current beat
      this.beats.forEach(beat => {
        if (beat.position === this.currentBeat) {
          this.audioManager.playBeat(beat);
        }
      });

      const endOfTrack = Math.max(16, Array.from(this.notes.values()).flat().map(n => n.start + n.length).reduce((a, b) => Math.max(a, b), 0));

      this.currentBeat += 0.5;

      if (this.currentBeat >= endOfTrack) {
        const loopToggle = document.getElementById('loop-toggle') as HTMLInputElement;
        if (!loopToggle.checked) {
          this.stop();
          return;
        }
        this.currentBeat = 0;
      }

      this.loopTimeout = setTimeout(playLoop, beatDuration * 1000);
    };

    playLoop();
  }

  private stop() {
    this.isPlaying = false;
    this.currentBeat = 0;
    this.renderPlayButton();
    this.loopTimeout && clearTimeout(this.loopTimeout);
  }
  
  private renderPlayButton() {
    const playBtn = document.getElementById('play-btn') as HTMLButtonElement;
    if (this.isPlaying) {
      playBtn.classList.add('is-playing');
      playBtn.textContent = 'stop';
      playBtn.dataset.i18n = 'stop';
      playBtn.title = i18next.t('stop');
    } else {
      playBtn.classList.remove('is-playing');
      playBtn.textContent = 'play_arrow';
      playBtn.dataset.i18n = 'play';
      playBtn.title = i18next.t('play');
    }
  }
}

// Initialize the sequencer when the page loads
new Sequencer();