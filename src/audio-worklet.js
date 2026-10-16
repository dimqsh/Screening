class CaptureProcessor extends AudioWorkletProcessor {
 constructor(){super();this.buffer=new Float32Array(4096);this.offset=0;}
 process(inputs){const channels=inputs[0];if(channels?.length){const source=channels[0];for(let i=0;i<source.length;i++){let sample=0;for(const channel of channels)sample+=channel[i];this.buffer[this.offset++]=sample/channels.length;if(this.offset===4096){this.port.postMessage(this.buffer);this.buffer=new Float32Array(4096);this.offset=0;}}}return true;}
}
registerProcessor('capture-processor',CaptureProcessor);
