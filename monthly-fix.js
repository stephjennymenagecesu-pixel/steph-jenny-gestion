/*
 * Steph & Jenny Gestion — correctif mensuel + Google Agenda
 * - passage automatique au mois courant
 * - compteur mensuel à zéro au nouveau mois
 * - conservation historique/clôtures/reports
 * - rendez-vous du jour visibles toute la journée
 * - import Google Agenda du mois courant + 3 mois suivants
 */

function sjLocalMonthKey(d=new Date()){
  return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0");
}

function sjLocalDateKey(d=new Date()){
  return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");
}

function sjSyncCurrentMonth(){
  const current=sjLocalMonthKey();

  if(db.month!==current){
    db.month=current;
    db.ui=db.ui||{};
    db.ui.monthAutoChangedAt=new Date().toISOString();
    save();
    return true;
  }

  return false;
}

/* Les rendez-vous du jour restent visibles jusqu'à minuit */
isPastPlan=function(p){
  return !p?.date || p.date < sjLocalDateKey();
};

/* Affiche aussi les prochains mois */
futurePlans=function(){
  const todayKey=sjLocalDateKey();

  return (db.planning||[])
    .filter(p=>p.date && p.date>=todayKey && !isDonePlan(p))
    .sort((a,b)=>planDateTime(a)-planDateTime(b));
};

donePlans=function(){
  const todayKey=sjLocalDateKey();

  return (db.planning||[])
    .filter(p=>isDonePlan(p) || (p.date && p.date<todayKey))
    .sort((a,b)=>planDateTime(b)-planDateTime(a));
};

planning=function(){
  sjSyncCurrentMonth();

  let pl=futurePlans();
  let done=donePlans();

  layout(`<button onclick="go('home')">← Retour</button>
  <h2>Planning</h2>

  <div class="card ok">
    <p><b>Planning à jour</b></p>
    <p>Les rendez-vous d'aujourd'hui restent visibles toute la journée.</p>
    <p>Les rendez-vous des prochains mois peuvent aussi s'afficher.</p>
  </div>

  <button class=big onclick="go('google')">
    📅 Google Agenda / Actualiser
  </button>

  ${pl.map(p=>`
    <div class=item>
      <b>${p.client}</b>
      <p>${fd(p.date)} ${p.time||""}<br>${p.type||"Ménage"}</p>
      <button class=big onclick="startFromPlan('${p.id}')">
        ▶️ Démarrer le chrono
      </button>
      <button onclick="markPlanDone('${p.id}')">
        ✅ Marquer fait
      </button>
    </div>
  `).join("") || "<div class=card>Aucun rendez-vous à venir.</div>"}

  <div class=card>
    <h3>Historique masqué</h3>
    <p class=small>${done.length} intervention(s) passée(s) ou terminée(s).</p>
    <button onclick="showDonePlans()">Voir l’historique</button>
  </div>`);
};

google=function(){
  sjSyncCurrentMonth();

  const connected =
    db.google.accessToken &&
    Date.now()<db.google.expiresAt;

  layout(`<button onclick="go('home')">← Retour</button>
  <h2>Google Agenda</h2>

  <div class=card>
    <p>Compte : <b>${db.google.email}</b></p>
    <p>État : <b>${connected ? "connecté" : "non connecté / session expirée"}</b></p>
  </div>

  <div class="card ok">
    <p><b>Import du planning</b></p>
    <p>Le bouton récupère le mois en cours et les 3 mois suivants.</p>
    <p>Les rendez-vous déjà importés sont mis à jour automatiquement.</p>
  </div>

  <div class=card>
    <label>Client ID Google</label>
    <textarea id=g>${db.google.clientId||""}</textarea>

    <button class=big onclick="
      db.google.clientId=$('#g').value.trim();
      save();
      alert('Client ID enregistré')
    ">
      💾 Enregistrer
    </button>
  </div>

  <div class=grid>
    <button onclick=connectGoogle()>🔐 Se connecter</button>
    <button onclick=loadGoogleEvents()>⬇️ Actualiser planning</button>
    <button onclick="window.open('https://calendar.google.com/calendar/u/0/r','_blank')">
      📅 Ouvrir
    </button>
  </div>`);
};

async function sjFetchAllGoogleEvents(url){
  let items=[];
  let nextPageToken="";

  do{
    const sep=url.includes("?") ? "&" : "?";

    const pageUrl =
      nextPageToken
      ? url+sep+"pageToken="+encodeURIComponent(nextPageToken)
      : url;

    const r=await gfetch(pageUrl);

    let data={};

    try{
      data=await r.json();
    }catch(e){}

    if(!r.ok){
      const msg =
        data?.error?.message ||
        ("Erreur Google "+r.status);

      const err=new Error(msg);
      err.status=r.status;
      throw err;
    }

    items.push(...(data.items||[]));
    nextPageToken=data.nextPageToken||"";

  }while(nextPageToken);

  return items;
}

loadGoogleEvents=async function(silent=false){
  try{
    sjSyncCurrentMonth();

    if(
      !db.google.accessToken ||
      Date.now()>=db.google.expiresAt
    ){
      if(!silent){
        alert(
          "La connexion Google a expiré. Appuie sur « Se connecter », puis sur « Actualiser planning »."
        );
      }

      return {
        found:0,
        added:0,
        updated:0
      };
    }

    const now=new Date();

    const st=new Date(
      now.getFullYear(),
      now.getMonth(),
      1,
      0,0,0,0
    );

    const en=new Date(
      now.getFullYear(),
      now.getMonth()+4,
      1,
      0,0,0,0
    );

    const base =
      `https://www.googleapis.com/calendar/v3/calendars/primary/events`+
      `?timeMin=${encodeURIComponent(st.toISOString())}`+
      `&timeMax=${encodeURIComponent(en.toISOString())}`+
      `&singleEvents=true`+
      `&orderBy=startTime`+
      `&maxResults=2500`;

    const items=
      await sjFetchAllGoogleEvents(base);

    let added=0;
    let updated=0;
    let found=0;

    items
      .filter(ev=>ev.status!=="cancelled")
      .forEach(ev=>{

        const dt =
          ev.start?.dateTime ||
          ev.start?.date;

        if(!dt)return;

        found++;

        const summary =
          ev.summary ||
          "RDV";

        const newData={
          googleId:ev.id,
          date:dt.slice(0,10),
          time:
            ev.start?.dateTime
            ? dt.slice(11,16)
            : "09:00",
          client:guess(summary),
          type:summary
        };

        const existing=
          (db.planning||[])
          .find(p=>p.googleId===ev.id);

        if(existing){

          const changed =
            existing.date!==newData.date ||
            existing.time!==newData.time ||
            existing.client!==newData.client ||
            existing.type!==newData.type;

          Object.assign(existing,newData);

          if(changed)updated++;

        }else{

          db.planning.push({
            id:uid(),
            ...newData
          });

          added++;
        }
      });

    save();

    if(!silent){
      alert(
        found+" rendez-vous trouvé(s) dans Google Agenda.\n"+
        added+" nouveau(x) ajouté(s).\n"+
        updated+" rendez-vous mis à jour."
      );

      go("planning");
    }

    return {
      found,
      added,
      updated
    };

  }catch(e){

    console.error("Import Google Agenda",e);

    if(!silent){

      if(e?.status===401){

        alert(
          "La connexion Google a expiré. Reconnecte Google puis relance l'actualisation."
        );

      }else{

        alert(
          "Erreur pendant l'import Google Agenda : "+
          (e?.message||"erreur inconnue")
        );
      }
    }

    return {
      found:0,
      added:0,
      updated:0,
      error:e
    };
  }
};

/* Passage automatique au nouveau mois */
const sjMonthChanged=
  sjSyncCurrentMonth();

if(sjMonthChanged){
  render();
}

/* Vérification si l'application reste ouverte */
setInterval(()=>{
  if(sjSyncCurrentMonth()){
    render();
  }
},5*60*1000);

/* Vérification quand on revient dans l'application */
document.addEventListener(
  "visibilitychange",
  ()=>{

    if(!document.hidden){

      const changed=
        sjSyncCurrentMonth();

      if(changed){
        render();
      }

      if(
        db.google?.accessToken &&
        Date.now()<db.google.expiresAt
      ){
        loadGoogleEvents(true)
          .then(()=>{
            if(screen==="planning"){
              planning();
            }
          });
      }
    }
  }
);

/* Actualisation silencieuse à l'ouverture */
if(
  db.google?.accessToken &&
  Date.now()<db.google.expiresAt
){
  setTimeout(()=>{
    loadGoogleEvents(true)
      .then(()=>{
        if(screen==="planning"){
          planning();
        }
      });
  },1200);
}
/* PDF DIRECT IPHONE / PWA */

async function sjClientPDF(){

  try{

    if(!window.jspdf?.jsPDF){
      alert("Le module PDF n'est pas encore chargé. Ferme puis rouvre l'application.");
      return;
    }

    const { jsPDF } = window.jspdf;

    const n =
      knownClientName(
        db.ui?.recapClient ||
        clients()[0]?.name
      );

    if(!n){
      alert("Aucun client sélectionné.");
      return;
    }

    const d = rowData(n);

    const pdf = new jsPDF({
      unit: "mm",
      format: "a4"
    });

    let y = 18;

    const ligne = (texte, taille=11, gras=false) => {

      if(y > 280){
        pdf.addPage();
        y = 18;
      }

      pdf.setFontSize(taille);
      pdf.setFont(
        "helvetica",
        gras ? "bold" : "normal"
      );

      const lignes =
        pdf.splitTextToSize(
          String(texte),
          180
        );

      pdf.text(lignes, 15, y);

      y += lignes.length * 6;
    };

    ligne("Steph & Jenny", 18, true);
    ligne("RÉCAPITULATIF & FACTURATION", 12, true);

    ligne(
      cap(monthLabel(db.month)),
      12,
      true
    );

    y += 3;

    ligne(n, 16, true);

    if(isClientClosed(n)){
      ligne("Clôturé", 10, true);
    }

    y += 4;

    ligne("Interventions", 13, true);

    d.it
      .slice()
      .sort((a,b)=>a.date.localeCompare(b.date))
      .forEach(x=>{

        const debut =
          ft(new Date(x.start));

        const fin =
          ft(new Date(x.end));

        ligne(
          fd(x.date) +
          "  •  " +
          debut +
          " - " +
          fin +
          "  •  " +
          fmin(x.duration) +
          "  •  " +
          (x.type || "Ménage"),
          10
        );
      });

    y += 4;

    ligne("Stéphanie", 14, true);

    ligne(
      "Temps réel : " +
      fmin(d.rs)
    );

    ligne(
      "Report début " +
      cap(monthLabel(db.month)) +
      " : " +
      rt(d.cs.rep)
    );

    ligne(
      "À déclarer : " +
      d.cs.d +
      " h"
    );

    ligne(
      "Report fin vers " +
      cap(monthLabel(nextM(db.month))) +
      " : " +
      rt(d.cs.next)
    );

    ligne(
      "Montant : " +
      euros(d.totalS),
      11,
      true
    );

    y += 4;

    ligne("Jennyfer", 14, true);

    ligne(
      "Temps réel : " +
      fmin(d.rj)
    );

    ligne(
      "Report début " +
      cap(monthLabel(db.month)) +
      " : " +
      rt(d.cj.rep)
    );

    ligne(
      "À déclarer : " +
      d.cj.d +
      " h"
    );

    ligne(
      "Report fin vers " +
      cap(monthLabel(nextM(db.month))) +
      " : " +
      rt(d.cj.next)
    );

    ligne(
      "Montant : " +
      euros(d.totalJ),
      11,
      true
    );

    const nomFichier =
      "Recap_" +
      n.replace(/[^a-zA-Z0-9À-ÿ_-]+/g,"_") +
      "_" +
      db.month +
      ".pdf";

    const blob =
      pdf.output("blob");

    const fichier =
      new File(
        [blob],
        nomFichier,
        {type:"application/pdf"}
      );

    if(
      navigator.share &&
      navigator.canShare?.({
        files:[fichier]
      })
    ){

      await navigator.share({
        files:[fichier],
        title:"Récapitulatif "+n
      });

    }else{

      const url =
        URL.createObjectURL(blob);

      const a =
        document.createElement("a");

      a.href = url;
      a.download = nomFichier;

      document.body.appendChild(a);
      a.click();
      a.remove();

      setTimeout(
        ()=>URL.revokeObjectURL(url),
        5000
      );
    }

  }catch(e){

    console.error(e);

    alert(
      "Impossible de créer le PDF : " +
      (e?.message || "erreur inconnue")
    );
  }
}


/* Le bouton PDF utilise maintenant le vrai PDF */

const sjOriginalClientRecapPDF = clientRecap;

clientRecap = function(n){

  sjOriginalClientRecapPDF(n);

  document
    .querySelectorAll(".noPrint button")
    .forEach(btn=>{

      if(btn.textContent.includes("PDF")){

        btn.onclick = sjClientPDF;

        btn.textContent =
          "📄 Envoyer PDF";
      }
    });
};
/* CORRECTION BOUTON CLIENT DÉJÀ CLÔTURÉ */

const sjOriginalClientRecap = clientRecap;

clientRecap = function(n){

  sjOriginalClientRecap(n);

  const clientName =
    knownClientName(
      n ||
      db.ui?.recapClient ||
      clients()[0]?.name
    );

  if(!clientName) return;

  const boutons =
    document.querySelectorAll(".noPrint button");

  boutons.forEach(btn => {

    if(
      isClientClosed(clientName) &&
      btn.textContent.includes("Clôturer")
    ){
      btn.textContent = "↩️ Réouvrir ce client";

      btn.onclick = function(){
        reopenClient(clientName);
      };
    }
  });
};
