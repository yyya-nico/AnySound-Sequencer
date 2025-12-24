/* eslint-disable no-restricted-globals */
self.addEventListener('message', (e) => {
  const data = e.data;
  if (!data || data.type !== 'encode') return;

  try {
    const sampleRate = data.sampleRate;
    const numChannels = data.numChannels;
    const length = data.length; // samples per channel
    const bitsPerSample = data.bitsPerSample || 16;
    const channelBuffers: ArrayBuffer[] = data.channels;

    const bytesPerSample = bitsPerSample / 8;
    const blockAlign = numChannels * bytesPerSample;
    const dataLength = length * blockAlign;
    const bufferLength = 44 + dataLength;

    const arrayBuffer = new ArrayBuffer(bufferLength);
    const view = new DataView(arrayBuffer);

    const writeString = (offset: number, str: string) => {
      for (let i = 0; i < str.length; i++) {
        view.setUint8(offset + i, str.charCodeAt(i));
      }
    };

    writeString(0, 'RIFF');
    view.setUint32(4, 36 + dataLength, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);
    writeString(36, 'data');
    view.setUint32(40, dataLength, true);

    // Reconstruct channel Float32Arrays from transferred buffers
    const channels: Float32Array[] = channelBuffers.map((buf) => new Float32Array(buf));

    let offset = 44;
    const total = length;
    const chunk = Math.max(1024, Math.floor(total / 200)); // ~200 updates at most

    for (let i = 0; i < length; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        let sample = channels[ch][i] || 0;
        sample = Math.max(-1, Math.min(1, sample));
        const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
        view.setInt16(offset, Math.round(intSample), true);
        offset += 2;
      }

      if ((i & 0xffff) === 0 || i % chunk === 0) {
        // send progress periodically
        self.postMessage({ type: 'progress', processed: i, total });
      }
    }

    // final progress
    self.postMessage({ type: 'progress', processed: total, total });

    // Transfer the ArrayBuffer back to main thread
    self.postMessage({ type: 'done', buffer: arrayBuffer }, { transfer: [arrayBuffer] });
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err) });
  }
});
