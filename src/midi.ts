// MIDI File Input/Output Class
// Supports Standard MIDI File Format (SMF)

interface MidiEvent {
  deltaTime: number;
  type: 'noteOn' | 'noteOff' | 'meta' | 'sysex' | 'controller' | 'programChange' | 'unknown';
  channel?: number;
  note?: number;
  velocity?: number;
  controller?: number;
  value?: number;
  metaType?: number;
  data?: Uint8Array;
  program?: number;
}

interface MidiTrack {
  events: MidiEvent[];
}

interface MidiFile {
  format: number; // 0, 1, or 2
  tracks: MidiTrack[];
  ticksPerQuarter: number;
}

export class MidiParser {
  private data: Uint8Array;
  private pos: number = 0;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  // Parse MIDI file from binary data
  parse(): MidiFile {
    this.pos = 0;
    
    // Read header chunk
    const headerChunk = this.readChunk();
    if (this.arrayToString(headerChunk.type) !== 'MThd') {
      throw new Error('Invalid MIDI file: missing MThd header');
    }
    
    if (headerChunk.data.length !== 6) {
      throw new Error('Invalid MIDI header length');
    }
    
    const format = this.readUint16(headerChunk.data, 0);
    const trackCount = this.readUint16(headerChunk.data, 2);
    const division = this.readUint16(headerChunk.data, 4);
    
    const midiFile: MidiFile = {
      format,
      tracks: [],
      ticksPerQuarter: division
    };
    
    // Read track chunks
    for (let i = 0; i < trackCount; i++) {
      const trackChunk = this.readChunk();
      if (this.arrayToString(trackChunk.type) !== 'MTrk') {
        throw new Error(`Invalid track chunk ${i}: missing MTrk header`);
      }
      
      const track = this.parseTrack(trackChunk.data);
      midiFile.tracks.push(track);
    }
    
    return midiFile;
  }

  private readChunk(): { type: Uint8Array; data: Uint8Array } {
    const type = this.data.slice(this.pos, this.pos + 4);
    this.pos += 4;
    
    const length = this.readUint32();
    const data = this.data.slice(this.pos, this.pos + length);
    this.pos += length;
    
    return { type, data };
  }

  private parseTrack(data: Uint8Array): MidiTrack {
    const track: MidiTrack = { events: [] };
    let pos = 0;
    let runningStatus = 0;
    
    while (pos < data.length) {
      // Read delta time
      const deltaTime = this.readVariableLength(data, pos);
      pos += deltaTime.bytesRead;
      
      // Read event
      let status = data[pos];
      
      // Handle running status
      if (status < 0x80) {
        status = runningStatus;
      } else {
        pos++;
        runningStatus = status;
      }
      
      const event: MidiEvent = {
        deltaTime: deltaTime.value,
        type: 'noteOn' // default, will be overwritten
      };
      if (status >= 0x80 && status <= 0x8F) {
        // Note Off
        event.type = 'noteOff';
        event.channel = status & 0x0F;
        event.note = data[pos++];
        event.velocity = data[pos++];
      } else if (status >= 0x90 && status <= 0x9F) {
        // Note On
        event.type = 'noteOn';
        event.channel = status & 0x0F;
        event.note = data[pos++];
        event.velocity = data[pos++];
        
        // Note On with velocity 0 is actually Note Off
        if (event.velocity === 0) {
          event.type = 'noteOff';
        }
      } else if (status >= 0xB0 && status <= 0xBF) {
        // Control Change
        event.type = 'controller';
        event.channel = status & 0x0F;
        event.controller = data[pos++];
        event.value = data[pos++];
      } else if (status === 0xFF) {
        // Meta Event
        event.type = 'meta';
        event.metaType = data[pos++];
        const length = this.readVariableLength(data, pos);
        pos += length.bytesRead;
        event.data = data.slice(pos, pos + length.value);
        pos += length.value;
      } else if (status >= 0xC0 && status <= 0xCF) {
        // Program Change
        event.type = 'programChange';
        event.channel = status & 0x0F;
        event.program = data[pos++];
      } else if (status >= 0xE0 && status <= 0xEF) {
        // Pitch Bend
        event.type = 'controller';
        event.channel = status & 0x0F;
        const lsb = data[pos++];
        const msb = data[pos++];
        event.value = (msb << 7) | lsb;
      } else if (status === 0xF0 || status === 0xF7) {
        // SysEx Event
        event.type = 'sysex';
        const length = this.readVariableLength(data, pos);
        pos += length.bytesRead;
        event.data = data.slice(pos, pos + length.value);
        pos += length.value;
      } else {
        // Skip unknown events
        console.warn(`Unknown MIDI event: 0x${status.toString(16)}`);
        event.type = 'unknown';
        pos++;
      }
      
      track.events.push(event);
    }
    
    return track;
  }

  private readVariableLength(data: Uint8Array, pos: number): { value: number; bytesRead: number } {
    let value = 0;
    let bytesRead = 0;
    
    while (bytesRead < 4) {
      const byte = data[pos + bytesRead];
      value = (value << 7) | (byte & 0x7F);
      bytesRead++;
      
      if ((byte & 0x80) === 0) {
        break;
      }
    }
    
    return { value, bytesRead };
  }

  private readUint16(data: Uint8Array, offset: number): number {
    return (data[offset] << 8) | data[offset + 1];
  }

  private readUint32(): number {
    const value = (this.data[this.pos] << 24) | 
                  (this.data[this.pos + 1] << 16) | 
                  (this.data[this.pos + 2] << 8) | 
                  this.data[this.pos + 3];
    this.pos += 4;
    return value >>> 0; // Convert to unsigned
  }

  private arrayToString(array: Uint8Array): string {
    return String.fromCharCode(...array);
  }
}

export class MidiWriter {
  // Convert MidiFile to binary data
  static write(midiFile: MidiFile): Uint8Array {
    const chunks: Uint8Array[] = [];
    
    // Write header chunk
    const headerData = new Uint8Array(6);
    this.writeUint16(headerData, 0, midiFile.format);
    this.writeUint16(headerData, 2, midiFile.tracks.length);
    this.writeUint16(headerData, 4, midiFile.ticksPerQuarter);
    
    chunks.push(this.createChunk('MThd', headerData));
    
    // Write track chunks
    for (const track of midiFile.tracks) {
      const trackData = this.writeTrack(track);
      chunks.push(this.createChunk('MTrk', trackData));
    }
    
    // Combine all chunks
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const result = new Uint8Array(totalLength);
    let pos = 0;
    
    for (const chunk of chunks) {
      result.set(chunk, pos);
      pos += chunk.length;
    }
    
    return result;
  }

  private static writeTrack(track: MidiTrack): Uint8Array {
    const events: Uint8Array[] = [];
    
    for (const event of track.events) {
      // Write delta time
      events.push(this.writeVariableLength(event.deltaTime));
      
      // Write event data
      if (event.type === 'noteOn') {
        const eventData = new Uint8Array(3);
        eventData[0] = 0x90 | (event.channel || 0);
        eventData[1] = event.note || 0;
        eventData[2] = event.velocity || 0;
        events.push(eventData);
      } else if (event.type === 'noteOff') {
        const eventData = new Uint8Array(3);
        eventData[0] = 0x80 | (event.channel || 0);
        eventData[1] = event.note || 0;
        eventData[2] = event.velocity || 0;
        events.push(eventData);
      } else if (event.type === 'controller') {
        const eventData = new Uint8Array(3);
        eventData[0] = 0xB0 | (event.channel || 0);
        eventData[1] = event.controller || 0;
        eventData[2] = event.value || 0;
        events.push(eventData);
      } else if (event.type === 'meta') {
        const metaData = new Uint8Array(2 + this.writeVariableLength(event.data?.length || 0).length + (event.data?.length || 0));
        let pos = 0;
        metaData[pos++] = 0xFF;
        metaData[pos++] = event.metaType || 0;
        const lengthBytes = this.writeVariableLength(event.data?.length || 0);
        metaData.set(lengthBytes, pos);
        pos += lengthBytes.length;
        if (event.data) {
          metaData.set(event.data, pos);
        }
        events.push(metaData);
      }
    }
    
    // Combine all events
    const totalLength = events.reduce((sum, event) => sum + event.length, 0);
    const result = new Uint8Array(totalLength);
    let pos = 0;
    
    for (const event of events) {
      result.set(event, pos);
      pos += event.length;
    }
    
    return result;
  }

  private static createChunk(type: string, data: Uint8Array): Uint8Array {
    const chunk = new Uint8Array(8 + data.length);
    
    // Write chunk type
    for (let i = 0; i < 4; i++) {
      chunk[i] = type.charCodeAt(i);
    }
    
    // Write chunk length
    this.writeUint32(chunk, 4, data.length);
    
    // Write data
    chunk.set(data, 8);
    
    return chunk;
  }

  private static writeVariableLength(value: number): Uint8Array {
    const bytes: number[] = [];
    bytes.push(value & 0x7F);
    
    while (value > 0x7F) {
      value >>= 7;
      bytes.unshift((value & 0x7F) | 0x80);
    }
    
    return new Uint8Array(bytes);
  }

  private static writeUint16(data: Uint8Array, offset: number, value: number): void {
    data[offset] = (value >> 8) & 0xFF;
    data[offset + 1] = value & 0xFF;
  }

  private static writeUint32(data: Uint8Array, offset: number, value: number): void {
    data[offset] = (value >> 24) & 0xFF;
    data[offset + 1] = (value >> 16) & 0xFF;
    data[offset + 2] = (value >> 8) & 0xFF;
    data[offset + 3] = value & 0xFF;
  }
}

// Utility class to convert between your Note/Beat format and MIDI
export class MidiConverter {
  // Convert your sequencer data to MIDI format
  static sequencerToMidi(
    notes: Array<{id: string; track: number; pitch: number; start: number; length: number; velocity: number}>,
    beats: Array<{id: string; track: number; position: number; velocity: number}>,
    bpm: number = 120,
    ticksPerQuarter: number = 480
  ): MidiFile {
    const midiFile: MidiFile = {
      format: 1,
      tracks: [],
      ticksPerQuarter
    };

    // Calculate ticks per beat (assuming 4/4 time)
    const ticksPerBeat = ticksPerQuarter;

    // Create tempo track
    const tempoTrack: MidiTrack = {
      events: [
        {
          deltaTime: 0,
          type: 'meta',
          metaType: 0x51, // Set Tempo
          data: this.createTempoData(bpm)
        },
        {
          deltaTime: 0,
          type: 'meta',
          metaType: 0x2F, // End of Track
          data: new Uint8Array(0)
        }
      ]
    };
    midiFile.tracks.push(tempoTrack);

    // Convert note tracks
    if (notes.length > 0) {
      // Group notes by track (channel)
      const notesByTrack = new Map<number, MidiEvent[]>();

      for (const note of notes) {
        const startTicks = Math.round(note.start * ticksPerBeat);
        const endTicks = Math.round((note.start + note.length) * ticksPerBeat);

        if (!notesByTrack.has(note.track)) {
          notesByTrack.set(note.track, []);
        }

        const trackEvents = notesByTrack.get(note.track)!;

        trackEvents.push({
          deltaTime: startTicks,
          type: 'noteOn',
          channel: note.track,
          note: note.pitch,
          velocity: note.velocity
        });

        trackEvents.push({
          deltaTime: endTicks,
          type: 'noteOff',
          channel: note.track,
          note: note.pitch,
          velocity: 0
        });
      }

      // Process each track's events
      const sortedTrackNumbers = Array.from(notesByTrack.keys()).sort((a, b) => a - b);
      for (const trackNumber of sortedTrackNumbers) {
        const trackEvents = notesByTrack.get(trackNumber)!;
        
        // Sort events by time and calculate delta times
        trackEvents.sort((a, b) => a.deltaTime - b.deltaTime);

        let lastTime = 0;
        for (const event of trackEvents) {
          const absoluteTime = event.deltaTime;
          event.deltaTime = absoluteTime - lastTime;
          lastTime = absoluteTime;
        }

        // Add end of track
        trackEvents.push({
          deltaTime: 0,
          type: 'meta',
          metaType: 0x2F,
          data: new Uint8Array(0)
        });

        midiFile.tracks.push({ events: trackEvents });
      }
    }

    // Convert beat tracks to percussion (channel 9)
    if (beats.length > 0) {
      const events: MidiEvent[] = [];
      
      for (const beat of beats) {
        const startTicks = Math.round(beat.position * ticksPerBeat);
        
        // Use different percussion notes for different tracks
        const percussionNote = beat.track === 1 ? 36 : 38; // Bass drum or snare
        
        events.push({
          deltaTime: startTicks,
          type: 'noteOn',
          channel: 9, // MIDI channel 10 (0-indexed as 9) is percussion
          note: percussionNote,
          velocity: beat.velocity
        });
        
        events.push({
          deltaTime: startTicks + (ticksPerBeat / 8), // Short note duration
          type: 'noteOff',
          channel: 9,
          note: percussionNote,
          velocity: 0
        });
      }

      // Sort and calculate delta times
      events.sort((a, b) => a.deltaTime - b.deltaTime);
      
      let lastTime = 0;
      for (const event of events) {
        const absoluteTime = event.deltaTime;
        event.deltaTime = absoluteTime - lastTime;
        lastTime = absoluteTime;
      }

      events.push({
        deltaTime: 0,
        type: 'meta',
        metaType: 0x2F,
        data: new Uint8Array(0)
      });

      midiFile.tracks.push({ events });
    }

    return midiFile;
  }

  // Convert MIDI format to your sequencer data
  static midiToSequencer(midiFile: MidiFile): {
    notes: Array<{id: string; track: number; pitch: number; start: number; length: number; velocity: number}>;
    beats: Array<{id: string; track: number; position: number; velocity: number}>;
    instrumentCodes: {[track: number]: number};
    bpm: number;
    gridSize: number;
  } {
    const notes: Array<{id: string; track: number; pitch: number; start: number; length: number; velocity: number}> = [];
    const beats: Array<{id: string; track: number; position: number; velocity: number}> = [];
    const instrumentCodes: {[track: number]: number} = {};
    
    const ticksPerBeat = midiFile.ticksPerQuarter;
    let bpm = 120, bpmConfirmed = false;
    let detectedEndOfTrack = 0;

    for (const track of midiFile.tracks) {
      const activeNotesByChannel = new Map<number, Map<number, {start: number; velocity: number}>>(); // channel -> note -> {start, velocity}
      
      let currentTicks = 0;

      for (const event of track.events) {
        currentTicks += event.deltaTime;
        const currentBeats = currentTicks / ticksPerBeat;

        if (event.type === 'meta' && event.metaType === 0x51 && event.data) {
          // Extract tempo
          if (!bpmConfirmed) {
            bpm = this.extractBpmFromTempoData(event.data);
          }
        } else if (event.type === 'noteOn' && event.note !== undefined && event.velocity !== undefined && event.velocity > 0) {
          const channel = event.channel || 0;

          bpmConfirmed = true;
          
          if (!activeNotesByChannel.has(channel)) {
            activeNotesByChannel.set(channel, new Map());
          }
          
          const channelNotes = activeNotesByChannel.get(channel)!;
          channelNotes.set(event.note, {
            start: currentBeats,
            velocity: event.velocity
          });
        } else if ((event.type === 'noteOff' || (event.type === 'noteOn' && event.velocity === 0)) && event.note !== undefined) {
          const channel = event.channel || 0;
          const channelNotes = activeNotesByChannel.get(channel);
          
          if (channelNotes) {
            const noteInfo = channelNotes.get(event.note);
            if (noteInfo) {
              const length = Math.max(0.1, currentBeats - noteInfo.start);
              
              if (channel === 9) {
                // Percussion track (MIDI channel 10)
                beats.push({
                  id: `beat-${Date.now()}-${Math.random()}`,
                  track: event.note === 36 ? 1 : 0, // Bass drum or snare
                  position: noteInfo.start,
                  velocity: noteInfo.velocity
                });
              } else {
                // Regular note
                notes.push({
                  id: `note-${Date.now()}-${Math.random()}`,
                  track: channel,
                  pitch: event.note,
                  start: noteInfo.start,
                  length,
                  velocity: noteInfo.velocity
                });
              }
              
              channelNotes.delete(event.note);
            }
          }
        } else if (event.type === 'programChange' && typeof event.program === 'number') {
          const channel = event.channel || 0;
          if (channel !== 9 && !instrumentCodes[channel]) { // Ignore percussion channel
            instrumentCodes[channel] = event.program;
          }
        } else if (event.type === 'meta' && event.metaType === 0x2F) {
          // End of track
          if (currentBeats > detectedEndOfTrack) {
            detectedEndOfTrack = currentBeats;
          }
        }
      }
    }

    return { notes, beats, instrumentCodes, bpm, gridSize: Math.ceil(detectedEndOfTrack) };
  }

  private static createTempoData(bpm: number): Uint8Array {
    // Microseconds per quarter note
    const microsecondsPerQuarter = Math.round(60000000 / bpm);
    const data = new Uint8Array(3);
    data[0] = (microsecondsPerQuarter >> 16) & 0xFF;
    data[1] = (microsecondsPerQuarter >> 8) & 0xFF;
    data[2] = microsecondsPerQuarter & 0xFF;
    return data;
  }

  private static extractBpmFromTempoData(data: Uint8Array): number {
    if (data.length !== 3) return 120;
    const microsecondsPerQuarter = (data[0] << 16) | (data[1] << 8) | data[2];
    return Math.round(60000000 / microsecondsPerQuarter);
  }
}