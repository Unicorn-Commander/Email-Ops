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
})();
