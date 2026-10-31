"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowLeft, CalendarDays, Check, ExternalLink, Heart, Info, Instagram, LoaderCircle, MapPin, RotateCcw, Sparkles, Undo2, X } from "lucide-react";
import { EVENT_CATEGORY_TONES, EventPriceChip } from "@/components/events/event-meta";
import { useRequireAuth } from "@/lib/auth/use-require-auth";
import { addDaysToDateKey, parseDateKeyToUtcNoon } from "@/lib/events/nightlife-date";
import type { PublicEventPostPreview } from "@/lib/events/public-event-post";
import { choicesForScope, DISCOVER_SCOPES, getDiscoverCategory, getDiscoverGestureAction, type DiscoverScope } from "@/lib/discover/swipe-session";
import { cn } from "@/lib/utils";
import type { MobileDiscoverEvent } from "@/lib/discover/mobile-event";
import { useDiscoverSelections } from "./use-discover-selections";
import { useDiscoverPhotoSnap } from "./use-discover-photo-snap";
import styles from "./mobile-discover.module.css";

type MobileDiscoverProps = {authEnabled:boolean; error?:string; events:MobileDiscoverEvent[]; selectedDate:string; today:string};
type DiscoverIdentity = {isLoaded:boolean;isSignedIn:boolean; userId:string|null};
const labels: Record<DiscoverScope,string> = {all:"All",club:"Zurke",live:"Live music",culture:"Kultura",event:"Ostalo"};

function dateLabel(value:string, long=false) {
  const parsed = parseDateKeyToUtcNoon(value);
  return parsed ? new Intl.DateTimeFormat("sr-Latn", {weekday:long?"long":"short",day:"numeric",month:long?"long":"short",timeZone:"Europe/Belgrade"}).format(parsed) : value;
}
function timeLabel(event:MobileDiscoverEvent) {
  return event.timeLabel;
}
function imageUrl(event:MobileDiscoverEvent) { return `/api/discover/images/${encodeURIComponent(event._id)}`; }

export function MobileDiscover(props:MobileDiscoverProps) {
  return props.authEnabled ? <AuthenticatedDiscover {...props} /> : <SwipeDiscover {...props} identity={{isLoaded:true,isSignedIn:false,userId:null}} />;
}
function AuthenticatedDiscover(props:MobileDiscoverProps) {
  const {isLoaded,isSignedIn,userId} = useRequireAuth();
  return <SwipeDiscover {...props} identity={{isLoaded,isSignedIn,userId}} />;
}

function SwipeDiscover({authEnabled,error,events,selectedDate,today,identity}:MobileDiscoverProps & {identity:DiscoverIdentity}) {
  const router = useRouter();
  const [navigating,startNavigation] = useTransition();
  const selection = useDiscoverSelections(identity, events);
  const {complete:completeSelection} = selection;
  const [scope,setScope] = useState<DiscoverScope>("all");
  const [summaryOpen,setSummaryOpen] = useState(false);
  const [busy,setBusy] = useState(false);
  const [exiting,setExiting] = useState<MobileDiscoverEvent|null>(null);
  const [announcement,setAnnouncement] = useState("");
  const [detail,setDetail] = useState<MobileDiscoverEvent|null>(null);
  const [removeError,setRemoveError] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const categories = useRef<HTMLDivElement>(null);
  const restartDialog = useRef<HTMLDialogElement>(null);
  const generation = useRef(0);
  const gesture = useRef<{id:number;x:number;y:number;startX:number;startY:number;lastX:number;lastAt:number;velocity:number;card:HTMLElement;dragging:boolean;maxDistance:number;photo:boolean}|null>(null);
  const dates = useMemo(()=>Array.from({length:7},(_,index)=>addDaysToDateKey(today,index)),[today]);
  const dayChoices = selection.sessions[selectedDate];
  const history = dayChoices?.choices ?? [];
  const seen = new Set(history.map(choice=>choice.eventId));
  const queue = events.filter(event=>scope === "all" || getDiscoverCategory(event) === scope);
  const remaining = queue.filter(event=>!seen.has(event._id));
  const scopedChoices = choicesForScope(dayChoices,scope);
  const likedIds = new Set(history.filter(choice=>choice.decision === "like").map(choice=>choice.eventId));
  const liked = events.filter(event=>likedIds.has(event._id));
  const completed = selection.hydrated && queue.length > 0 && remaining.length === 0;
  const showSummary = !busy && (summaryOpen || completed);
  const cards = (exiting ? [exiting,...remaining.filter(event=>event._id!==exiting._id)] : remaining).slice(0,3);
  const activeCount = queue.filter(event=>seen.has(event._id)).length;
  const locked = busy || navigating || !selection.hydrated;
  const scopeLabel = scope === "all" ? "sve kategorije" : labels[scope];
  const returnUrl = `/discover?date=${selectedDate}&category=${scope}`;
  const waitingForSave = selection.saving || (!selection.failedIds.length && !selection.areConfirmed(liked.map(event=>event._id)));

  useEffect(()=>{
    const requested = new URLSearchParams(window.location.search).get("category");
    if (DISCOVER_SCOPES.includes(requested as DiscoverScope)) setScope(requested as DiscoverScope);
  },[]);
  useDiscoverPhotoSnap(stage, !showSummary && selection.hydrated && cards.length > 0, styles.scrollRoot);
  useEffect(()=>{
    const chip = categories.current?.querySelector<HTMLElement>(`[data-category="${scope}"]`);
    if (chip && categories.current) {
      const {left,right} = chip.getBoundingClientRect(), container = categories.current.getBoundingClientRect();
      if (left < container.left) categories.current.scrollLeft -= container.left-left;
      else if (right > container.right) categories.current.scrollLeft += right-container.right;
    }
  },[scope]);
  useEffect(()=>{
    if (completed && !dayChoices?.completedScopes.includes(scope)) completeSelection(selectedDate,scope);
  },[completed,dayChoices,scope,selectedDate,completeSelection]);
  useEffect(()=>()=>{generation.current++;stage.current?.getAnimations({subtree:true}).forEach(animation=>animation.cancel());},[]);

  function switchScope(next:DiscoverScope) {
    if (locked || next === scope) return;
    generation.current++; gesture.current = null;
    stage.current?.getAnimations({subtree:true}).forEach(animation=>animation.cancel());
    setScope(next); setSummaryOpen(false);
    const url = new URL(window.location.href); url.searchParams.set("category",next); window.history.replaceState(null,"",url);
  }
  async function decide(decision:"like"|"skip",drag={x:0,y:0}) {
    const event = remaining[0], card = stage.current?.querySelector<HTMLElement>('[data-layer="0"]');
    if (locked || showSummary || !event || !card || detail || restartDialog.current?.open) return;
    const token = generation.current, direction = decision === "like" ? 1 : -1;
    gesture.current = null; setBusy(true); setExiting(event);
    // Persist before animation so a route change or closed tab cannot lose a swipe.
    selection.decide(selectedDate,{eventId:event._id,category:getDiscoverCategory(event),decision},scope,queue.map(item=>item._id));
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    card.getAnimations().forEach(animation=>animation.cancel());
    const stamp = card.querySelector<HTMLElement>(`[data-stamp="${decision}"]`);
    if (stamp) stamp.style.opacity = "1";
    const animation = card.animate([
      {transform:`translate3d(${drag.x}px,${drag.y*.18}px,0) rotate(${drag.x/18}deg)`,opacity:1},
      {transform:`translate3d(${direction*(reduced?12:window.innerWidth*1.4)}px,-28px,0) rotate(${reduced?0:direction*26}deg)`,opacity:0},
    ],{duration:reduced?100:360,easing:"cubic-bezier(.2,.7,.25,1)",fill:"forwards"});
    const next = stage.current?.querySelector<HTMLElement>('[data-layer="1"]');
    next?.animate([{transform:getComputedStyle(next).transform},{transform:"translateY(0) scale(1)"}],{duration:reduced?100:360,easing:"cubic-bezier(.2,.8,.25,1)",fill:"forwards"});
    await animation.finished.catch(()=>{});
    if (generation.current !== token) return;
    setExiting(null); setBusy(false);
    setAnnouncement(`${decision === "like" ? "Sviđa ti se" : "Preskočeno"}: ${event.title}.`);
  }

  function undo() {
    if (locked || !scopedChoices.length) return;
    generation.current++; selection.undo(selectedDate,scope); setSummaryOpen(false);
    setAnnouncement(`Vraćena poslednja kartica: ${scopeLabel}.`);
  }
  function resetDrag(card:HTMLElement,x:number,y:number) {
    card.style.transform = ""; card.classList.remove(styles.dragging);
    card.querySelectorAll<HTMLElement>("[data-stamp]").forEach(stamp=>{stamp.style.opacity="0";});
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) card.animate([{transform:`translate3d(${x}px,${y*.18}px,0) rotate(${x/18}deg)`},{transform:"translate3d(0,0,0) rotate(0deg)"}],{duration:280,easing:"cubic-bezier(.18,.8,.2,1)"});
  }
  function pointerDown(event:ReactPointerEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement, card = target.closest<HTMLElement>('[data-layer="0"]');
    const photo = Boolean(target.closest("[data-discover-photo]"));
    if (!card || locked || event.button !== 0 || (!photo && target.closest("button,a"))) return;
    card.getAnimations().forEach(animation=>animation.cancel());
    gesture.current={id:event.pointerId,x:0,y:0,startX:event.clientX,startY:event.clientY,lastX:0,lastAt:performance.now(),velocity:0,card,dragging:false,maxDistance:0,photo};
    card.setPointerCapture(event.pointerId);
  }
  function pointerMove(event:ReactPointerEvent<HTMLDivElement>) {
    const current = gesture.current; if (!current || current.id !== event.pointerId) return;
    const x=event.clientX-current.startX,y=event.clientY-current.startY,now=performance.now();
    current.maxDistance=Math.max(current.maxDistance,Math.hypot(x,y));
    if (!current.dragging && Math.abs(y)>16 && Math.abs(y)>Math.abs(x)*1.25) {gesture.current=null;current.card.releasePointerCapture(event.pointerId);return;}
    current.velocity=(x-current.lastX)/Math.max(1,now-current.lastAt);current.lastAt=now;current.lastX=x;current.x=x;current.y=y;
    if (Math.abs(x)>7) current.dragging=true;
    if (!current.dragging) return;
    current.card.classList.add(styles.dragging);
    current.card.style.transform=`translate3d(${x}px,${y*.18}px,0) rotate(${x/18}deg)`;
    const like=current.card.querySelector<HTMLElement>('[data-stamp="like"]'),skip=current.card.querySelector<HTMLElement>('[data-stamp="skip"]');
    if(like)like.style.opacity=String(Math.max(0,Math.min(1,x/85)));if(skip)skip.style.opacity=String(Math.max(0,Math.min(1,-x/85)));
  }
  function pointerUp(event:ReactPointerEvent<HTMLDivElement>,cancel=false) {
    const current=gesture.current;if(!current || current.id!==event.pointerId)return;gesture.current=null;
    if(!cancel){current.x=event.clientX-current.startX;current.y=event.clientY-current.startY;}
    current.maxDistance=Math.max(current.maxDistance,Math.hypot(current.x,current.y));
    if(current.card.hasPointerCapture(event.pointerId))current.card.releasePointerCapture(event.pointerId);
    const velocity=performance.now()-current.lastAt<110?current.velocity:0;
    const action=getDiscoverGestureAction({...current,velocity,width:stage.current?.clientWidth ?? 300,cancelled:cancel});
    if(action==="like" || action==="skip")void decide(action,current);
    else {
      resetDrag(current.card,current.x,current.y);
      if(action==="open"){
        const event=events.find(item=>item._id===current.card.dataset.eventId);
        if(event)setDetail(event);
      }
    }
  }

  return <main className={styles.main} data-discover-feed="mobile-swipe" onKeyDown={event=>{
    if((event.target as HTMLElement).closest("input,select,button,a,dialog") || locked || detail)return;
    if(event.key==="ArrowRight"){event.preventDefault();void decide("like");}if(event.key==="ArrowLeft"){event.preventDefault();void decide("skip");}if(event.key.toLowerCase()==="z"){event.preventDefault();undo();}
  }}>
    <h1 className="sr-only">Discover događaji</h1>
    <div className={styles.session}>
      <label className={styles.dayLabel}><CalendarDays aria-hidden="true" size={16}/><span className="sr-only">Dan za Discover</span><select aria-label="Dan za Discover" disabled={locked} onChange={event=>startNavigation(()=>router.push(`/discover?date=${event.target.value}&category=${scope}`))} value={selectedDate}>
        {!dates.includes(selectedDate)?<option value={selectedDate}>{dateLabel(selectedDate)}</option>:null}
        {dates.map(date=><option key={date} value={date}>{date===today?`Danas · ${dateLabel(date)}`:date===addDaysToDateKey(today,1)?`Sutra · ${dateLabel(date)}`:dateLabel(date)}</option>)}
      </select></label>
      <button aria-label={`Prikaži izbor za dan: ${liked.length} događaja${selection.failedIds.length?". Čuvanje nije uspelo; otvori izbor da pokušaš ponovo.":selection.saving?". Čuvanje je u toku.":""}`} className={styles.count} disabled={locked} onClick={()=>setSummaryOpen(true)} type="button">{selection.failedIds.length?<Info aria-hidden="true" size={16}/>:selection.saving?<LoaderCircle aria-hidden="true" className="motion-safe:animate-spin" size={16}/>:<Heart aria-hidden="true" size={16}/>}{liked.length}</button>
      {scopedChoices.length>0?<button aria-label={`Ponovo biraj: ${scopeLabel}`} className={styles.reset} disabled={locked} onClick={()=>restartDialog.current?.showModal()} title={`Ponovo biraj: ${scopeLabel}`} type="button"><RotateCcw aria-hidden="true" size={16}/></button>:null}
    </div>
    <div aria-label="Kategorije događaja" className={styles.categories} ref={categories} role="group">
      {DISCOVER_SCOPES.map(category=><button aria-pressed={category===scope} className={styles.chip} data-category={category} disabled={locked} key={category} onClick={()=>switchScope(category)} type="button">{category!=="all"?<span aria-hidden="true" className={styles.dot} style={{backgroundColor:EVENT_CATEGORY_TONES[category].color}}/>:null}{labels[category]}</button>)}
    </div>
    {showSummary?<section aria-label="Izbor događaja za dan" className={styles.summary}>
      <button className={styles.back} onClick={()=>completed?undo():setSummaryOpen(false)} type="button"><ArrowLeft aria-hidden="true" size={14}/>{completed?`Vrati poslednju · ${scopeLabel}`:"Nastavi pregledanje"}</button>
      {liked.length > 0 ? identity.isSignedIn ? <div aria-live="polite" className={styles.saveStatus}>{waitingForSave?<LoaderCircle aria-hidden="true" className="motion-safe:animate-spin" size={17}/>:selection.failedIds.length?<Info aria-hidden="true" size={17}/>:<Check aria-hidden="true" size={17}/>}<span>{waitingForSave?"Čuvanje…":selection.failedIds.length?"Neki događaji nisu sačuvani.":selection.areSaved(liked.map(event=>event._id))?"Izbor je sačuvan.":"Izbor je završen."}</span>{selection.failedIds.length?<button onClick={selection.retrySave} type="button">Pokušaj ponovo</button>:waitingForSave?null:<Link href="/saved">Saved</Link>}</div> : <div className={styles.callout}><p>Izbor se čuva na ovom uređaju. Prijavi se da ga sinhronizuješ.</p><Link className="button-secondary" href="/saved">Saved</Link>{authEnabled?<div><Link className="button-primary" href={`/sign-up?redirect_url=${encodeURIComponent(returnUrl)}`}>Napravi nalog</Link><Link className="button-secondary" href={`/sign-in?redirect_url=${encodeURIComponent(returnUrl)}`}>Već imam nalog</Link></div>:<p>Prijava trenutno nije dostupna.</p>}</div>:null}
      {scopedChoices.length?<div className={styles.summaryActions}>{completed?<button className="button-primary" onClick={undo} type="button"><Undo2 aria-hidden="true" size={14}/>Vrati poslednju · {labels[scope]}</button>:<button className="button-primary" onClick={()=>setSummaryOpen(false)} type="button">Nastavi · još {remaining.length}</button>}<button className="button-secondary" onClick={()=>restartDialog.current?.showModal()} type="button">Ponovo biraj · {labels[scope]}</button></div>:null}
      <div className={styles.likedList}>{liked.map(event=><article className={styles.liked} key={event._id}><button className={styles.likedOpen} onClick={()=>setDetail(event)} type="button"><span className={styles.thumb}><Image alt="" className="object-cover" fill sizes="58px" src={imageUrl(event)} unoptimized/></span><span><strong>{event.title}</strong><span>{event.venue}</span><span className={styles.likedTime}>{timeLabel(event)}</span></span></button><button aria-label={`Ukloni iz izbora: ${event.title}`} className={styles.remove} disabled={selection.saving||selection.isEventPending(event._id)} onClick={()=>{setRemoveError(false);void selection.removeLike(selectedDate,event._id).then(success=>setRemoveError(!success));}} type="button"><X aria-hidden="true" size={15}/></button></article>)}</div>
      {!liked.length?<p className={styles.emptyCopy}>Nijedan događaj nije izabran.</p>:null}
      {removeError?<p className={styles.emptyCopy} role="alert">Događaj nije uklonjen iz sačuvanih. Pokušaj ponovo u Saved.</p>:null}
    </section>:<section aria-label="Biraj događaje" className={styles.deck}>
      <div className={styles.progress}><div aria-label={`Pregledani događaji: ${labels[scope]}`} aria-valuemax={queue.length} aria-valuemin={0} aria-valuenow={activeCount} className={styles.progressTrack} role="progressbar"><div style={{width:queue.length?`${activeCount/queue.length*100}%`:"0%"}}/></div><span>{queue.length?`${Math.min(activeCount+1,queue.length)} / ${queue.length}`:"0 / 0"}</span></div>
      <div aria-label="Prevuci karticu levo ili desno" className={styles.stage} data-discover-anchor="card" onPointerCancel={event=>pointerUp(event,true)} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={event=>pointerUp(event)} ref={stage} tabIndex={0}>
        {!selection.hydrated || navigating ? <div aria-label="Učitavanje događaja" className={styles.empty} role="status"><LoaderCircle aria-hidden="true" className="motion-safe:animate-spin" size={26}/></div> : cards.length ? cards.map((event,index)=><SwipeCard event={event} key={event._id} layer={index} onDetails={()=>setDetail(event)}/>).reverse() : <div className={styles.empty}><CalendarDays aria-hidden="true" size={30}/><h2>{error?"Događaji nisu učitani.":"Nema događaja u ovoj kategoriji."}</h2><p>{error?"Pokušaj ponovo kasnije.":"Izaberi drugu kategoriju ili datum."}</p>{error?<button className="button-secondary" onClick={()=>router.refresh()} type="button">Pokušaj ponovo</button>:null}</div>}
      </div>
      <div className={styles.actions}><button aria-label={`Vrati poslednju odluku: ${scopeLabel}`} className={styles.undo} disabled={locked||!scopedChoices.length} onClick={undo} type="button"><Undo2 aria-hidden="true" size={16}/></button><button aria-label="Preskoči događaj" className={styles.reject} disabled={locked||!remaining.length} onClick={()=>void decide("skip")} type="button"><X aria-hidden="true" size={20}/></button><button aria-label="Sviđa mi se događaj" className={styles.like} disabled={locked||!remaining.length} onClick={()=>void decide("like")} type="button"><Heart aria-hidden="true" size={20}/></button></div>
    </section>}
    <p aria-live="polite" className="sr-only" role="status">{announcement}</p>
    <dialog aria-labelledby="discover-reset-title" className={styles.dialog} ref={restartDialog}><div className={styles.dialogHead}><h2 id="discover-reset-title">Ponovo biraj · {labels[scope]}</h2><button aria-label="Odustani" onClick={()=>restartDialog.current?.close()} type="button"><X aria-hidden="true" size={18}/></button></div><p className={styles.dialogCopy}>{scope==="all"?"Ponovo biraš sve kategorije za ovaj dan.":`Ponovo biraš samo ${labels[scope]}. Odluke za ostale kategorije ostaju.`} Događaji koji su već sačuvani ostaju u Saved.</p><div className={styles.dialogActions}><button className="button-secondary" onClick={()=>restartDialog.current?.close()} type="button">Odustani</button><button className="button-primary" onClick={()=>{selection.restart(selectedDate,scope);setSummaryOpen(false);restartDialog.current?.close();}} type="button">Ponovo biraj</button></div></dialog>
    {detail?<DiscoverDetails event={detail} onClose={()=>setDetail(null)}/>:null}
  </main>;
}

function SwipeCard({event,layer,onDetails}:{event:MobileDiscoverEvent;layer:number;onDetails:()=>void}) {
  const [failed,setFailed] = useState(false);
  const category=getDiscoverCategory(event), tone=EVENT_CATEGORY_TONES[category].color;
  return <article aria-hidden={layer>0?true:undefined} aria-label={layer===0?`${event.title}, ${event.venue}, ${timeLabel(event)}`:undefined} className={styles.card} data-event-id={event._id} data-layer={layer} inert={layer>0?true:undefined} style={{"--discover-tone":tone} as CSSProperties}>
    <div className={styles.cardTop}><span className={cn("inline-flex max-w-full items-center rounded-full px-2 py-0.5 text-[10px] font-semibold leading-4",styles.cardCategory)} data-event-category={category} style={{backgroundColor:EVENT_CATEGORY_TONES[category].backgroundColor,color:tone}}><span className="truncate">{EVENT_CATEGORY_TONES[category].label}</span></span><span>{dateLabel(event.date)}</span></div>
    <button aria-haspopup="dialog" aria-label={`Otvori detalje događaja: ${event.title}`} className={styles.photo} data-discover-photo={event._id} onClick={click=>{if(click.detail===0)onDetails();}} tabIndex={layer===0?0:-1} type="button">
      <span className={styles.posterFallback}>{failed?<span>Fotografija nije dostupna.</span>:<Sparkles aria-hidden="true" size={48}/>}</span>
      {!failed?<Image alt={`Originalna fotografija: ${event.title}`} className={styles.poster} draggable={false} fill loading={layer===0?"eager":"lazy"} onError={()=>setFailed(true)} priority={layer===0} sizes="(max-width: 502px) 100vw, 470px" src={imageUrl(event)} unoptimized/>:null}
    </button>
    <span aria-hidden="true" className={cn(styles.stamp,styles.likeStamp)} data-stamp="like">Sviđa mi se</span><span aria-hidden="true" className={cn(styles.stamp,styles.skipStamp)} data-stamp="skip">Preskačem</span>
    <div className={styles.cardBottom}><p className={styles.time}>{timeLabel(event)}</p><h2>{event.title}</h2><p className={styles.venue}><MapPin aria-hidden="true" size={13}/>{event.venue}</p><div className={styles.tags}><EventPriceChip value={event.ticketPrice}/>{event.tags.map(tag=><span className="inline-flex max-w-full items-center rounded-full bg-white/[0.06] px-2 py-0.5 text-[10px] font-medium leading-4 text-muted-foreground" data-event-tag={tag} key={tag}><span className="truncate">{tag}</span></span>)}</div>{layer===0?<button className={styles.details} onClick={onDetails} type="button"><Info aria-hidden="true" size={13}/>Detalji događaja<ExternalLink aria-hidden="true" size={12}/></button>:null}</div>
  </article>;
}

function DiscoverDetails({event,onClose}:{event:MobileDiscoverEvent;onClose:()=>void}) {
  const dialog=useRef<HTMLDialogElement>(null);
  const [post,setPost]=useState<PublicEventPostPreview|null>(null),[error,setError]=useState(false),[attempt,setAttempt]=useState(0);
  useEffect(()=>{dialog.current?.showModal();},[]);
  useEffect(()=>{
    const controller=new AbortController();setError(false);
    void fetch(`/api/events/${encodeURIComponent(event._id)}/post`,{cache:"no-store",signal:controller.signal}).then(async response=>{if(!response.ok)throw Error();const value=await response.json() as PublicEventPostPreview;if(value.eventId!==event._id)throw Error();if(!controller.signal.aborted)setPost(value);}).catch(()=>{if(!controller.signal.aborted)setError(true);});
    return ()=>controller.abort();
  },[attempt,event._id]);
  return <dialog aria-labelledby="discover-detail-title" className={cn(styles.dialog,styles.detailDialog)} onClose={onClose} ref={dialog}><div className={styles.dialogHead}><h2 id="discover-detail-title">{event.title}</h2><button aria-label="Zatvori detalje" onClick={()=>dialog.current?.close()} type="button"><X aria-hidden="true" size={18}/></button></div>{error?<div className={styles.detailCopy} role="alert"><p>Objava trenutno nije dostupna.</p><button className="button-secondary" onClick={()=>setAttempt(value=>value+1)} type="button">Pokušaj ponovo</button></div>:post?<><div className={styles.detailPoster}>{post.imageUrl?<Image alt={`${event.title} — originalna objava`} className="object-contain" fill sizes="100vw" src={post.imageUrl} unoptimized/>:null}</div><div className={styles.detailCopy}><p className={styles.captionLabel}>{post.captionSource==="instagram"?"Original caption":"Event description"}</p><p className={styles.caption}>{post.caption||"Opis nije dostupan."}</p></div><div className={styles.detailLinks}>{post.instagramPostUrl?<a href={post.instagramPostUrl} rel="noopener noreferrer" target="_blank"><Instagram aria-hidden="true" size={15}/>Instagram</a>:<span/>}<Link href={`/events/${event._id}`}><ExternalLink aria-hidden="true" size={15}/>Event details</Link></div></>:<div className={styles.detailCopy} role="status"><LoaderCircle aria-hidden="true" className="motion-safe:animate-spin" size={22}/><span className="sr-only">Učitavanje originalne objave</span></div>}</dialog>;
}
