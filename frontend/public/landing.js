// SPDX-FileCopyrightText: 2026 Magic Unicorn Unconventional Technology & Stuff Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later
(() => {
  // 30 rotating headlines — the payoff of each is wrapped in <em> so it renders
  // in the signature purple→pink→gold gradient. One is chosen at random on every
  // page load; the "Another headline" control shuffles to a different one.
  const headlines = [
    'Email with a <em>chain of command.</em>',
    'Your inbox called. It wants <em>adult supervision.</em>',
    'Let the agents type. Keep your finger on <em>Send.</em>',
    'Your email stack is six subscriptions in a <em>trench coat.</em>',
    'Give every agent an address. Keep every send <em>accountable.</em>',
    'The send button just got a <em>security clearance.</em>',
    'AI drafts. Humans decide. <em>Chaos retires.</em>',
    'Your agents can write. You still <em>outrank them.</em>',
    'The future of email has an <em>approval queue.</em>',
    'Inbox zero is cute. <em>Inbox control is better.</em>',
    'Because “let the AI send it” is <em>not a governance policy.</em>',
    'Your inbox, now with <em>rules of engagement.</em>',
    'The agent said “send.” Email-Ops said <em>“show your work.”</em>',
    'Email finally got an <em>operations department.</em>',
    'Autonomous enough to help. <em>Accountable enough to trust.</em>',
    'The only inbox where the robots <em>report up.</em>',
    'Stop managing email. <em>Start commanding it.</em>',
    'Your mail. Your rules. <em>Your agents.</em>',
    'Make email programmable, <em>not unpredictable.</em>',
    'One control plane. Every mailbox. <em>No mystery sends.</em>',
    'The safest place for AI to draft <em>“per my last email.”</em>',
    'Because every agent eventually discovers <em>Reply All.</em>',
    'The AI mailroom, minus the <em>mailroom fire.</em>',
    'Built for agents. Governed by humans. <em>Deployed your way.</em>',
    'Your domain. Your data. <em>Your rules of engagement.</em>',
    'Hosted when you want it. <em>Self-hosted when you mean it.</em>',
    'Cloud convenience. Enterprise control. <em>Open-source freedom.</em>',
    'Give your agents autonomy without <em>giving up authority.</em>',
    'The operational layer between intelligence and <em>Send.</em>',
    'A better email platform was apparently <em>not mythical after all.</em>'
  ];
  const headline = document.getElementById('rotating-headline');
  const shuffle = document.querySelector('.headline-shuffle');
  let current = Math.floor(Math.random() * headlines.length);
  const setHeadline = (index, animate = false) => {
    if (!headline) return;
    if (animate) {
      headline.animate([{opacity:1,transform:'translateY(0)'},{opacity:0,transform:'translateY(-12px)'}],{duration:180,fill:'forwards'}).onfinish=()=>{
        headline.innerHTML=headlines[index];
        headline.animate([{opacity:0,transform:'translateY(16px)'},{opacity:1,transform:'translateY(0)'}],{duration:350,fill:'forwards',easing:'cubic-bezier(.2,.8,.2,1)'});
      };
    } else headline.innerHTML = headlines[index];
  };
  setHeadline(current);
  shuffle?.addEventListener('click',()=>{let next=current;while(next===current)next=Math.floor(Math.random()*headlines.length);current=next;setHeadline(current,true)});

  const observer = new IntersectionObserver(entries => entries.forEach(e => { if(e.isIntersecting){e.target.classList.add('visible');observer.unobserve(e.target)}}), {threshold:.13});
  document.querySelectorAll('.reveal').forEach(el => observer.observe(el));

  const meter = document.querySelector('.scroll-meter span');
  const updateScroll = () => {
    const max = document.documentElement.scrollHeight - innerHeight;
    const p = max > 0 ? scrollY / max : 0;
    if(meter) meter.style.height = `${p*100}%`;
  };
  addEventListener('scroll', updateScroll, {passive:true}); updateScroll();

  const glow = document.querySelector('.cursor-glow');
  addEventListener('pointermove', e => { if(glow){glow.style.left=e.clientX+'px';glow.style.top=e.clientY+'px'} }, {passive:true});

  const tilt = document.querySelector('[data-tilt]');
  if(tilt && matchMedia('(pointer:fine)').matches){
    tilt.addEventListener('pointermove', e => {
      const r=tilt.getBoundingClientRect(); const x=(e.clientX-r.left)/r.width-.5; const y=(e.clientY-r.top)/r.height-.5;
      tilt.style.transform=`rotateY(${x*6-5}deg) rotateX(${-y*5+2}deg) rotateZ(1deg)`;
    });
    tilt.addEventListener('pointerleave',()=>tilt.style.transform='rotateY(-7deg) rotateX(2deg) rotateZ(1deg)');
  }

  const dialog = document.querySelector('.image-modal');
  const dialogImg = dialog?.querySelector('img');
  document.querySelectorAll('[data-full]').forEach(btn => btn.addEventListener('click',()=>{if(dialog&&dialogImg){dialogImg.src=btn.dataset.full;dialog.showModal()}}));
  dialog?.querySelector('.modal-close')?.addEventListener('click',()=>dialog.close());
  dialog?.addEventListener('click',e=>{if(e.target===dialog)dialog.close()});

  const menu = document.querySelector('.menu-button');
  const header = document.querySelector('.site-header');
  menu?.addEventListener('click',()=>{const open=header.classList.toggle('open');menu.setAttribute('aria-expanded',String(open))});
  header?.querySelectorAll('nav a').forEach(a=>a.addEventListener('click',()=>{header.classList.remove('open');menu?.setAttribute('aria-expanded','false')}));

  // --- 06 · capability detail cards ---
  const CAP = {
    'mail-engine':{n:'01',icon:'@',c:'#7c4dff',title:'Sovereign mail engine',
      tag:'You own the mail plane — your domain, your mailboxes, your data — instead of renting an inbox from a provider that quietly reads it.',
      means:'Email-Ops can run a real mail server for your domain, or ride on the one you already have. Either way the identities, policy, and audit live in one system you control.',
      stack:['Apache James (JMAP + SMTP)','Your own domain','DKIM · SPF · DMARC aligned','Postmark or your own relay','Managed or self-hosted'],
      points:['Real MX — not a forwarding hack','Per-domain isolation','Bring-your-own or fully managed']},
    'approvals':{n:'02',icon:'✓',c:'#43e0ad',title:'Approval-gated sending',
      tag:'Nothing an agent writes leaves without the authority level you set. Draft → review → approve → send, every step recorded.',
      means:'Each agent gets an autonomy level. Low-trust agents can only draft; earned trust lets messages move; everything stays on an audit trail you can replay.',
      stack:['Agent Inbox approval queue','L0 · draft-only','L1 · approve-to-send','L2 · autonomous + audit','Full audit trail'],
      points:['Trust set per agent','Edit before you approve','Every decision reversible + logged']},
    'cleanup':{n:'03',icon:'⌁',c:'#50a7ff',title:'Connected inbox cleanup',
      tag:'Point Email-Ops at the Gmail or Microsoft inbox you already have — it triages and proposes cleanup, but stages every destructive action for your review.',
      means:'Connect an external mailbox with a brokered token. The stateless Cleaner Engine analyzes it metadata-first and plans batches; deletes and moves wait in the approval queue.',
      stack:['Google + Microsoft OAuth (brokered)','Stateless Cleaner Engine','Metadata-first analysis','Staged, reviewable batches'],
      points:['Read-fence on by default','Plan before anything is deleted','Unsubscribe + organize in bulk']},
    'policy':{n:'04',icon:'⊘',c:'#ffd032',title:'Sender policy',
      tag:'Decide who can reach a mailbox — and who an agent is allowed to reach — at the address or domain level.',
      means:'Sender policy applies allow / block rules across triage and filtering, per identity, before an agent ever acts on a message.',
      stack:['Allow / block rules','Address- or domain-level','Inbound + outbound','Per-mailbox + per-agent'],
      points:['Stops a runaway Reply-All','Applied before agents act','Same rules on every identity']},
    'mcp':{n:'05',icon:'M',c:'#e06acb',title:'MCP-native operation',
      tag:'Agents don\'t screen-scrape your email — they call real, governed tools. Email-Ops is a first-class MCP server.',
      means:'Mail, threads, cleanup, policy, provisioning, the agent inbox, and even UI actions are exposed as typed MCP tools that enforce the same permissions as the interface.',
      stack:['Native MCP server','Typed tools, not scraping','Same RBAC as the UI','Works with Claude + any MCP client'],
      points:['Drop into any agent stack','No brittle automation','Governed by the same policy']},
    'health':{n:'06',icon:'◎',c:'#b052ff',title:'Health + audit',
      tag:'One operational view of what the engine is doing, what is queued, what failed, and who did what. Email as an operations discipline, not a mystery.',
      means:'See engine and queue health, failed sends, approvals, and agent state in one place — with an immutable history of every action for audit.',
      stack:['Live engine + queue health','Failed-send surfacing','Approval + agent state','Immutable audit log'],
      points:['Know the moment delivery breaks','Nothing happens off the record','Operational history you can replay']}
  };
  const capModal = document.querySelector('.cap-modal');
  const capBody = capModal && capModal.querySelector('.cap-modal-body');
  const openCap = key => {
    const d = CAP[key]; if(!d || !capModal || !capBody) return;
    capModal.style.setProperty('--c', d.c);
    capBody.innerHTML =
      '<div class="cm-top"><div class="cm-icon">'+d.icon+'</div><div><div class="cm-num">'+d.n+' / CAPABILITY</div><h3>'+d.title+'</h3></div></div>'+
      '<p class="cm-tag">'+d.tag+'</p>'+
      '<h4>What it means</h4><p class="cm-means">'+d.means+'</p>'+
      '<h4>What runs under it</h4><div class="cm-stack">'+d.stack.map(s=>'<span>'+s+'</span>').join('')+'</div>'+
      '<h4>In practice</h4><ul class="cm-points">'+d.points.map(p=>'<li>'+p+'</li>').join('')+'</ul>';
    capModal.showModal();
  };
  document.querySelectorAll('.cap-card[data-cap]').forEach(card => {
    const key = card.dataset.cap;
    card.addEventListener('click', () => openCap(key));
    card.addEventListener('keydown', e => { if(e.key==='Enter'||e.key===' '){ e.preventDefault(); openCap(key); } });
  });
  capModal?.querySelector('.cap-modal-close')?.addEventListener('click', ()=>capModal.close());
  capModal?.addEventListener('click', e => { if(e.target===capModal) capModal.close(); });

  window.__eoReady = 1; // signals the safety-net (in landing.html) that this script ran fully
})();
