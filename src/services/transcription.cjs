const { Worker } = require('node:worker_threads');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
class Transcription {
  constructor(cacheDir, onChange, onText) {
    this.cacheDir=cacheDir; this.onChange=onChange; this.onText=onText; this.worker=null; this.native=null; this.pending=new Map(); this.nextId=0; this.generation=0;
    this.state={status:'idle',ready:false,progress:null,file:'',error:null,pending:0,recording:false,source:null};
  }
  update(patch) { Object.assign(this.state,patch);this.onChange?.(this.state); }
  load() {
    if (this.worker) { if(this.state.ready) this.update({status:'ready'}); return; }
    fs.mkdirSync(this.cacheDir,{recursive:true});
    this.update({status:'loading',error:null});
    this.worker=new Worker(path.join(__dirname,'whisper-worker.cjs'),{workerData:{cacheDir:this.cacheDir}});
    this.worker.on('message', msg=>{
      if(msg.type==='progress') this.update({status:'loading',progress:msg.progress ?? null,file:msg.file || ''});
      if(msg.type==='ready') this.update({status:'ready',ready:true,progress:100,error:null});
      if(msg.type==='text' || msg.type==='error') {
        const job=this.pending.get(msg.id);this.pending.delete(msg.id);this.update({pending:this.pending.size});
        if(msg.type==='error') {this.update({error:msg.error,status:'error',...(msg.id===undefined?{ready:false}:{})});job?.reject(new Error(msg.error));if(msg.id===undefined){this.worker?.terminate();this.worker=null;}}
        else { job?.resolve(msg.text); if(msg.text && job?.generation===this.generation) this.onText?.(msg.text); }
      }
    });
    this.worker.on('error',e=>{ this.update({status:'error',ready:false,error:e.message});for(const job of this.pending.values())job.reject(e);this.pending.clear();this.worker=null; });
    this.worker.postMessage({type:'load'});
  }
  transcribe(samples,language='auto') {
    if(!this.state.ready) return Promise.reject(new Error('Download/load Whisper first.'));
    if(!(samples instanceof Float32Array) || samples.length<1600 || samples.length>16000*30) return Promise.reject(new Error('Expected 0.1–30 seconds of mono 16 kHz audio.'));
    if(this.pending.size>=3) return Promise.reject(new Error('Whisper is behind. Stop recording or use shorter sessions.'));
    for(const v of samples) if(!Number.isFinite(v)) return Promise.reject(new Error('Invalid audio sample'));
    const id=++this.nextId;
    return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject,generation:this.generation});this.update({pending:this.pending.size});this.worker.postMessage({type:'transcribe',id,samples:samples.buffer,language},[samples.buffer]);});
  }
  async startNative(helper, language) {
    if(process.platform!=='darwin')throw new Error('Native audio requires macOS');
    if(!this.state.ready)throw new Error('Load Whisper first.');
    if(this.native)throw new Error('Recording already started.');
    let data=Buffer.alloc(0), diagnostic='';
    const child=spawn(helper,[],{stdio:['ignore','pipe','pipe']}); this.native=child;
    this.update({recording:true,source:'system',error:null});
    child.stdout.on('data',chunk=>{
      data=Buffer.concat([data,chunk]);
      const bytes=16000*8*4;
      while(data.length>=bytes){const segment=data.subarray(0,bytes);data=data.subarray(bytes);const copy=new Uint8Array(segment).buffer;this.transcribe(new Float32Array(copy),language).catch(e=>this.update({error:e.message}));}
    });
    child.stderr.on('data',chunk=>{diagnostic+=chunk;if(diagnostic.length>4000)diagnostic=diagnostic.slice(-4000);});
    child.once('error',e=>{this.native=null;this.update({recording:false,error:e.message});});
    child.once('close',code=>{
      this.native=null;
      if(data.length>=16000*4){const copy=new Uint8Array(data.subarray(0,data.length-data.length%4)).buffer;this.transcribe(new Float32Array(copy),language).catch(()=>{});}
      this.update({recording:false,...(code && code!==0 ? {error:diagnostic.trim().slice(-400) || 'System audio capture stopped.'}: {})});
    });
  }
  stop() {this.native?.kill('SIGTERM');this.update({recording:false,source:null});}
  clear() {this.generation++;}
  close() { this.native?.kill();this.worker?.terminate();for(const job of this.pending.values())job.reject(new Error('Closed'));this.pending.clear(); }
}
module.exports={Transcription};
