// Embedded in three sequential Code nodes; imports are not available in n8n.
export async function publishEventZekaSpecial({env,httpRequest,getStaticData,plan,format,now=()=>new Date(),random=Math.random,forceDryRun=false}) {
  const dry=forceDryRun||String(env.EVENTZEKA_SOCIAL_DRY_RUN||'').toLowerCase()==='true';
  const clock=()=>{
    const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Belgrade',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now());
    const get=key=>parts.find(part=>part.type===key).value;
    return {date:[get('year'),get('month'),get('day')].join('-'),time:get('hour')+':'+get('minute')};
  };
  const current=clock();
  if(!dry&&current.date!=='2026-10-25')return [{json:{status:'skipped_outside_special_date',format,publishDate:current.date,continue:false}}];
  if(!dry&&current.time<'10:00')return [{json:{status:'skipped_before_special_time',format,publishDate:current.date,continue:false}}];
  const caption='Iza\u0111i i glasaj!';
  if(plan?.id!=='eventzeka-special-2026-10-25-v1'||plan.date!=='2026-10-25'||plan.timezone!=='Europe/Belgrade'||plan.caption!==caption||
    plan.scheduledUtc!=='2026-10-25T09:00:00Z'||plan.locationId!=='109920975697736'||plan.shareToFeed!==false||plan.durationSeconds!==15||!['post','story','reel'].includes(format))throw new Error('Invalid one-off publication plan.');
  for(const key of ['post','story','reel','cover']){
    const asset=plan.assets?.[key];
    const file={post:'post.jpg',story:'story.jpg',reel:'reel.mp4',cover:'reel-cover.jpg'}[key];
    if(!asset||asset.file!==file||!/^[a-f0-9]{64}$/.test(asset.sha256)||asset.url!==`https://eventzeka.com/api/social/special/2026-10-25/${file}?v=${asset.sha256}`||
      asset.contentType!==(key==='reel'?'video/mp4':'image/jpeg')||!Number.isSafeInteger(asset.bytes)||asset.bytes<1000||asset.bytes>(key==='reel'?300000000:8000000))throw new Error('Invalid pinned special publication asset.');
  }
  const preview={format,publishDate:plan.date,scheduledLocal:'2026-10-25 10:00 Europe/Belgrade',scheduledUtc:plan.scheduledUtc,caption,
    mediaUrl:plan.assets[format].url,coverUrl:format==='reel'?plan.assets.cover.url:null,locationName:plan.locationName,
    musicMode:format==='reel'?'instagram_catalog':'none',shareToFeed:format==='reel'?false:null};
  const state=dry?null:getStaticData();
  const existing=state?.specialPublications?.[plan.id];
  if(existing?.pending)return [{json:{status:'blocked_reconciliation_required',...preview,pending:existing.pending,continue:false}}];
  if(existing?.receipts?.[format]?.mediaId)return [{json:{status:'skipped_already_published',...preview,mediaId:existing.receipts[format].mediaId,continue:true}}];
  if(!dry&&format!=='post'&&!existing?.receipts?.[format==='story'?'post':'story']?.mediaId)return [{json:{status:'blocked_previous_format_required',...preview,continue:false}}];
  const tokens=[env.EVENTZEKA_IG_ACCESS_TOKEN,env.EVENTZEKA_REELS_FB_ACCESS_TOKEN,env.EVENTZEKA_CRON_SECRET].filter(Boolean);
  const safe=value=>tokens.reduce((message,token)=>message.replaceAll(token,'[redacted]'),value instanceof Error?value.message:String(value));
  const parse=body=>{if(body&&typeof body==='object')return body;try{return JSON.parse(body||'{}');}catch{return {};}};
  const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const igId=String(env.EVENTZEKA_IG_USER_ID||''),fbId=String(env.EVENTZEKA_REELS_IG_USER_ID||'');
  if(!dry&&(!/^\d+$/.test(igId)||!/^\d+$/.test(fbId)||!env.EVENTZEKA_IG_ACCESS_TOKEN||!env.EVENTZEKA_REELS_FB_ACCESS_TOKEN))return [{json:{status:'blocked_meta_authorization_required',...preview,continue:false}}];
  async function graph(reel,path,body){
    const base=reel?'https://graph.facebook.com':String(env.EVENTZEKA_IG_GRAPH_BASE_URL||'https://graph.instagram.com').replace(/\/+$/,'');
    const version=String((reel?env.EVENTZEKA_REELS_GRAPH_VERSION:env.EVENTZEKA_IG_GRAPH_VERSION)||'v25.0');
    if(!['https://graph.facebook.com','https://graph.instagram.com'].includes(base)||!/^v\d+\.\d+$/.test(version))throw new Error('Invalid Meta connection configuration.');
    const token=reel?env.EVENTZEKA_REELS_FB_ACCESS_TOKEN:env.EVENTZEKA_IG_ACCESS_TOKEN;
    const response=await httpRequest({method:body?'POST':'GET',url:`${base}/${version}/${path}`,
      headers:{Authorization:`Bearer ${token}`,Accept:'application/json',...(body?{'Content-Type':'application/x-www-form-urlencoded'}:{})},
      body:body?Object.entries(body).map(([key,value])=>`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`).join('&'):undefined,
      returnFullResponse:true,ignoreHttpStatusErrors:true,timeout:120000});
    const data=parse(response.body);
    if(Number(response.statusCode)<200||Number(response.statusCode)>=300)throw new Error(safe(data.error?.message||`Meta HTTP ${response.statusCode}.`));
    return data;
  }
  let campaign;
  try{
    // Validate every format before the first public action, including exact bytes.
    for(const asset of Object.values(plan.assets)){
      const response=await httpRequest({method:'HEAD',url:asset.url,returnFullResponse:true,ignoreHttpStatusErrors:true,timeout:60000});
      const headers=response.headers||{};
      if(Number(response.statusCode)!==200||String(headers['content-type']||headers['Content-Type']||'').split(';')[0]!==asset.contentType||
        String(headers['x-content-sha256']||headers['X-Content-Sha256']||'')!==asset.sha256||Number(headers['content-length']||headers['Content-Length'])!==asset.bytes)throw new Error('Special publication media preflight failed.');
    }
    if(dry)return [{json:{status:'dry_run',...preview,continue:true}}];
    const fingerprint=[plan.sourceSha256,...Object.values(plan.assets).map(asset=>asset.sha256),caption].join(':');
    state.specialPublications=state.specialPublications||{};
    campaign=state.specialPublications[plan.id]||(state.specialPublications[plan.id]={fingerprint,receipts:{},prepared:{}});
    if(campaign.fingerprint!==fingerprint)throw new Error('The frozen special publication plan changed.');
    const remaining=['post','story','reel'].filter(key=>!campaign.receipts[key]?.mediaId).length;
    const quota=await graph(true,`${fbId}/content_publishing_limit?fields=quota_usage,config`);
    const allowance=quota.data?.[0];
    if(!Number.isFinite(allowance?.quota_usage)||!Number.isFinite(allowance?.config?.quota_total)||allowance.quota_usage+remaining>allowance.config.quota_total)throw new Error('Insufficient verified Instagram publication quota.');
    if(!campaign.audio){
      const catalog=await graph(true,`ig_audio?audio_type=music&user_id=${encodeURIComponent(fbId)}`);
      const seen=new Set();
      const tracks=(Array.isArray(catalog.audio)?catalog.audio:[]).map((track,index)=>({...track,catalogRank:index+1})).filter(track=>/^\d+$/.test(String(track.audio_id||''))&&Number(track.duration_in_ms)>=15000&&typeof track.title==='string'&&track.title.trim()).filter(track=>{
        const key=`${track.title}:${track.display_artist||''}`.toLocaleLowerCase();if(seen.has(key))return false;seen.add(key);return true;
      }).slice(0,3);
      if(!tracks.length)throw new Error('No eligible trending catalog music is available.');
      const track=tracks[Math.min(tracks.length-1,Math.max(0,Math.floor(random()*tracks.length)))];
      campaign.audio={id:String(track.audio_id),title:track.title,artist:track.display_artist||'',catalogRank:track.catalogRank};
    }
    const reel=format==='reel',id=reel?fbId:igId;
    const prepared=campaign.prepared[format]||(campaign.prepared[format]={});
    if(!prepared.containerId){
      const body={location_id:plan.locationId,...(format==='post'?{image_url:plan.assets.post.url,caption}:format==='story'?{media_type:'STORIES',image_url:plan.assets.story.url}:{media_type:'REELS',video_url:plan.assets.reel.url,cover_url:plan.assets.cover.url,caption,share_to_feed:'false',audio_configuration:JSON.stringify({audio_id:campaign.audio.id,audio_volume:80,video_volume:1})})};
      const created=await graph(reel,`${id}/media`,body);
      if(!created.id)throw new Error('Meta did not return a special publication container ID.');
      prepared.containerId=created.id;
    }
    let ready=false;
    for(let attempt=0;attempt<(reel?36:18);attempt++){
      const status=await graph(reel,`${prepared.containerId}?fields=status_code,status`);
      if(status.status_code==='FINISHED'){ready=true;break;}
      if(['ERROR','EXPIRED','PUBLISHED'].includes(status.status_code))throw new Error(`Container requires reconciliation: ${status.status_code}.`);
      await pause(5000);
    }
    if(!ready)throw new Error('Special publication container is still processing.');
    const liveClock=clock();
    if(liveClock.date!==plan.date||liveClock.time<'10:00')throw new Error('The special publication date changed during preparation.');
    // Never repeat media_publish after an ambiguous response.
    campaign.pending={format,containerId:prepared.containerId,startedAt:now().toISOString()};
    let result;
    try{
      result=await graph(reel,`${id}/media_publish`,{creation_id:prepared.containerId});
      if(!result.id)throw new Error('Meta did not return a published media ID.');
    }catch(error){
      campaign.pending.error=safe(error);
      return [{json:{status:'blocked_reconciliation_required',...preview,pending:campaign.pending,continue:false}}];
    }
    campaign.receipts[format]={mediaId:result.id,containerId:prepared.containerId,publishedAt:now().toISOString(),assetSha256:plan.assets[format].sha256};
    delete campaign.pending;
    campaign.completed=['post','story','reel'].every(key=>campaign.receipts[key]?.mediaId);
    if(campaign.completed)campaign.completedAt=now().toISOString();
    return [{json:{status:'published',...preview,mediaId:result.id,audio:format==='reel'?campaign.audio:null,completed:campaign.completed,continue:true}}];
  }catch(error){
    // Return normally so n8n retains earlier successes and any prepared container.
    if(campaign)campaign.lastError={format,message:safe(error),at:now().toISOString()};
    return [{json:{status:'blocked_special_preparation',...preview,reason:safe(error),continue:false}}];
  }
}
