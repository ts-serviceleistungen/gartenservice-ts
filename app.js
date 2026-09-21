const {createClient}=supabase;
const db=createClient(SUPABASE_URL,SUPABASE_PUBLISHABLE_KEY);
const $=id=>document.getElementById(id);
const FUNCTION_URL=`${SUPABASE_URL}/functions/v1/notify-new-request`;

function calculateDuration(){
  const selected=[...document.querySelectorAll('input[name=garden]:checked')].map(x=>x.value);
  let hours=0, inspection=false;
  if(selected.includes('Rasenmähen')){
    const area=$('garden_area').value;
    if(area==='bis 100 m²') hours+=2;
    else if(area==='100–250 m²') hours+=3;
    else if(area==='250–500 m²') hours+=4;
    else if(area==='500–1.000 m²') hours+=5;
    else if(area==='über 1.000 m²') inspection=true;
    else inspection=true;
  }
  for(const x of selected){ if(x!=='Rasenmähen') hours+=4; }
  if(!selected.length) return {hours:0,label:'Bitte mindestens eine Gartenarbeit auswählen.',inspection:false};
  if(inspection) return {hours,label:hours?`${hours} Stunden + Besichtigung erforderlich`:'Besichtigung erforderlich',inspection:true};
  const days=Math.floor(hours/8), rest=hours%8;
  let label;
  if(rest===0) label=`${days} Arbeitstag${days===1?'':'e'}`;
  else if(hours===4) label='½ Arbeitstag';
  else if(hours===12) label='1½ Arbeitstage';
  else label=`${hours} Stunden`;
  return {hours,label,inspection:false};
}

function updateUI(){
  const selected=[...document.querySelectorAll('input[name=garden]:checked')];
  $('areaBox').classList.toggle('hidden',!selected.some(x=>x.value==='Rasenmähen'));
  const d=calculateDuration();
  $('durationInfo').innerHTML=`<b>Voraussichtliche Bearbeitungsdauer: ${d.label}</b><br>Der Termin wird erst nach Prüfung und Bestätigung durch T.S. Serviceleistungen verbindlich.`;
}

async function loadBookedWindows(){
  const from=new Date(); from.setDate(from.getDate()+1);
  const to=new Date(from); to.setDate(to.getDate()+90);
  const {data,error}=await db.rpc('get_all_booked_windows',{p_from:from.toISOString().slice(0,10),p_to:to.toISOString().slice(0,10)});
  if(error){console.warn(error);return []} return data||[];
}
function addBusinessDays(date,count){const d=new Date(date);while(count>0){d.setDate(d.getDate()+1);if(d.getDay()!==0&&d.getDay()!==6)count--}return d}
function makeDesiredBlocks(date,time,duration){
  const blocks=[];let remaining=duration.hours;let day=new Date(`${date}T00:00:00`);
  while(day.getDay()===0||day.getDay()===6)day.setDate(day.getDate()+1);
  if(remaining>=8){while(remaining>=8){const s=new Date(day);s.setHours(8,0,0,0);const e=new Date(day);e.setHours(16,0,0,0);blocks.push([s,e]);remaining-=8;day=addBusinessDays(day,1)}if(remaining>0){const s=new Date(day);s.setHours(8,0,0,0);blocks.push([s,new Date(s.getTime()+remaining*3600000)])}}
  else {const s=new Date(day);s.setHours(Number(time.slice(0,2)),0,0,0);blocks.push([s,new Date(s.getTime()+remaining*3600000)])}
  return blocks;
}
async function validateAvailability(){
  const date=$('requested_date').value,d=calculateDuration();
  if(!date||!d.hours||d.inspection)return true;
  const windows=await loadBookedWindows();
  const blocked=makeDesiredBlocks(date,$('requested_time').value,d).some(([s,e])=>windows.some(w=>new Date(w.booking_start)<e&&new Date(w.booking_end)>s));
  if(blocked){$('msg').textContent='Der gewünschte Zeitraum ist bereits belegt. Bitte wählen Sie einen anderen Termin.';$('msg').classList.remove('hidden');return false}
  $('msg').classList.add('hidden');return true;
}

$('requested_date').min=new Date(Date.now()+86400000).toISOString().slice(0,10);
document.querySelectorAll('input[name=garden]').forEach(x=>x.addEventListener('change',updateUI));
$('garden_area').addEventListener('change',updateUI);
$('requested_date').addEventListener('change',validateAvailability);
$('requested_time').addEventListener('change',validateAvailability);
updateUI();

$('form').onsubmit=async e=>{
 e.preventDefault();const btn=e.submitter;btn.disabled=true;btn.textContent='Wird gesendet …';
 try{
  const d=calculateDuration();if(!d.hours){throw new Error('Bitte wählen Sie mindestens eine Gartenarbeit aus.')}
  if(d.inspection){throw new Error('Für Rasenflächen über 1.000 m² ist zunächst eine Besichtigung erforderlich.')}
  if(!(await validateAvailability()))return;
  const requestId=crypto.randomUUID();
  let selected=[...document.querySelectorAll('input[name=garden]:checked')].map(x=>x.value);
  if(selected.includes('Rasenmähen') && $('garden_area').value) selected.push('Rasenfläche: '+$('garden_area').value);
  const request={id:requestId,service_type:'Gartenarbeiten',status:'Neue Anfrage',first_name:$('first_name').value,last_name:$('last_name').value,phone:$('phone').value,email:$('email').value,requested_date:$('requested_date').value,requested_time:$('requested_time').value,care_options:selected,details:$('details').value,message:$('message').value,privacy_consent:$('privacy_consent').checked,garden_area:$('garden_area').value || null,garden_condition:$('garden_condition').value || null,duration_hours:d.hours,duration_label:d.label};
  const r=await db.from('requests').insert(request);if(r.error)throw r.error;
  const files=[...$('photos').files];for(const file of files){const ext=(file.name.split('.').pop()||'jpg').toLowerCase().replace(/[^a-z0-9]/g,'');const path=`${requestId}/${crypto.randomUUID()}.${ext||'jpg'}`;const up=await db.storage.from('vehicle-photos').upload(path,file,{contentType:file.type||'image/jpeg'});if(up.error)throw up.error;const ph=await db.from('request_photos').insert({request_id:requestId,storage_path:path});if(ph.error)throw ph.error}
  const notify=await fetch(FUNCTION_URL,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({request})});if(!notify.ok)console.warn(await notify.text());
  $('msg').textContent=`Vielen Dank. Ihre Gartenanfrage wurde erfolgreich übermittelt. Voraussichtliche Bearbeitungsdauer: ${d.label}. Der Termin wird nach Prüfung bestätigt.`;$('msg').classList.remove('hidden');e.target.reset();updateUI();
 }catch(err){$('msg').textContent='Die Anfrage konnte nicht gesendet werden: '+err.message;$('msg').classList.remove('hidden')}finally{btn.disabled=false;btn.textContent='Gartenanfrage absenden'}
};
