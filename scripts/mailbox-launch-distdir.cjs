// Artifact-only adapter: frozen next.config/start sources remain byte-identical.
const path=require('path'),dist=".next-c9f-7ad46f1a",seen=new Set();
for(const app of ['web','docs']){
 const appRoot='/app/apps/'+app;
 let resolved;try{resolved=require.resolve('next/dist/server/config',{paths:[appRoot]});}catch{continue;}
 if(seen.has(resolved))continue;seen.add(resolved);
 const original=require(resolved);if(typeof original.default!=='function')throw Error('Pinned Next config loader shape changed');
 require.cache[resolved].exports={...original,__esModule:true,default:async function(...args){
  let config=await original.default(...args);const dir=path.resolve(args[1]||'.');
  if(dir==='/app/apps/web'||dir==='/app/apps/docs'){
   if(config.distDir!=='.next')throw Error('Unexpected frozen distDir');
   if(process.env.JE4NDEV_LAUNCH_BUILD==='true'){
    if(dir==='/app/apps/web'&&config.allowedDevOrigins!==undefined){
     if(JSON.stringify(config.allowedDevOrigins)!=='["127.0.0.1","localhost"]')throw Error('Unexpected preview origins');
     config={...config,allowedDevOrigins:undefined};
    }
    console.log('LAUNCH_DISTDIR='+dir+':'+dist);
   }
   return {...config,distDir:dir==='/app/apps/docs'?".next-launch-e03d4fc7-d444b3b9f8954aeeb64c3fa3017ad3f6":dist};
  }
  return config;
 }};
}
