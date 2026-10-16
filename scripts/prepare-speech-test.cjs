const fs=require('node:fs/promises');
const assert=require('node:assert/strict');
(async()=>{
 const response=await fetch('https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/samples/jfk.wav');
 if(!response.ok)throw new Error('Fixture download failed');
 const wav=Buffer.from(await response.arrayBuffer());
 assert.equal(wav.toString('ascii',0,4),'RIFF');assert.equal(wav.toString('ascii',8,12),'WAVE');
 let offset=12,raw,rate,channels,bits,format;
 while(offset+8<=wav.length){const key=wav.toString('ascii',offset,offset+4),size=wav.readUInt32LE(offset+4),start=offset+8;if(key==='fmt '){format=wav.readUInt16LE(start);channels=wav.readUInt16LE(start+2);rate=wav.readUInt32LE(start+4);bits=wav.readUInt16LE(start+14);}if(key==='data')raw=wav.subarray(start,start+size);offset=start+size+(size%2);}
 assert.equal(format,1);assert.equal(channels,1);assert.equal(rate,16000);assert.equal(bits,16);assert.ok(raw.length>1000);
 const samples=new Float32Array(raw.length/2);for(let i=0;i<samples.length;i++)samples[i]=raw.readInt16LE(i*2)/32768;
 await fs.mkdir('build',{recursive:true});await fs.writeFile('build/jfk.f32',Buffer.from(samples.buffer));console.log('Prepared public Whisper speech fixture');
})().catch(error=>{console.error(error);process.exitCode=1;});
