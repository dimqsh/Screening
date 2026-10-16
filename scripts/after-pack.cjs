const path=require('node:path');
const {execFileSync}=require('node:child_process');
module.exports=async function(context){
 if(context.electronPlatformName!=='darwin')return;
 const bundle=path.join(context.appOutDir,'Capture Lab.app');
 execFileSync('/usr/bin/codesign',['--force','--deep','--sign','-',bundle],{stdio:'inherit'});
 execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',bundle],{stdio:'inherit'});
};
