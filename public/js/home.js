(function(){
  var d=document.documentElement; d.classList.add('js');
  var reduce=window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Reveal on scroll
  var els=[].slice.call(document.querySelectorAll('.rv'));
  if(reduce||!('IntersectionObserver' in window)){els.forEach(function(e){e.classList.add('in')})}
  else{
    var io=new IntersectionObserver(function(en){en.forEach(function(e){if(e.isIntersecting){e.target.classList.add('in');io.unobserve(e.target)}})},{rootMargin:'0px 0px -8% 0px',threshold:.12});
    els.forEach(function(e){io.observe(e)});
  }

  // Hero: slow parallax, only while the hero is on screen
  var media=document.getElementById('heroMedia'), hero=document.querySelector('.hero'), ticking=false;
  if(!reduce&&media){
    window.addEventListener('scroll',function(){
      if(ticking)return; ticking=true;
      requestAnimationFrame(function(){
        var y=window.scrollY; if(y<hero.offsetHeight){media.style.transform='translate3d(0,'+(y*.22).toFixed(1)+'px,0)'}
        ticking=false;
      });
    },{passive:true});
  }

  // Hero video: poster only for reduced motion or Save-Data
  var v=document.getElementById('heroVideo');
  if(v){
    var saveData=navigator.connection&&navigator.connection.saveData;
    if(reduce||saveData){v.removeAttribute('autoplay');v.pause();v.preload='none';v.remove()}
    else{var p=v.play&&v.play();if(p&&p.catch)p.catch(function(){})}
  }

  // Course profile: the orange line follows your scroll through the section
  var course=document.getElementById('course'), run=document.getElementById('courseRun');
  var mks=[].slice.call(document.querySelectorAll('.mk'));
  function drawCourse(){
    var r=course.getBoundingClientRect(), vh=window.innerHeight;
    var p=reduce?1:Math.min(1,Math.max(0,(vh*.9-r.top)/(vh*.75)));
    run.style.strokeDashoffset=(1000*(1-p)).toFixed(1);
    mks.forEach(function(m){m.classList.toggle('on',p>=parseFloat(m.dataset.at))});
  }
  if(course){drawCourse();window.addEventListener('scroll',function(){requestAnimationFrame(drawCourse)},{passive:true});window.addEventListener('resize',drawCourse)}

  // Manifesto: slow parallax on the still
  var man=document.getElementById('manMedia');
  if(man&&!reduce){window.addEventListener('scroll',function(){requestAnimationFrame(function(){
    var r=man.parentNode.getBoundingClientRect(), vh=window.innerHeight;
    if(r.bottom>0&&r.top<vh){man.style.transform='translate3d(0,'+((r.top+r.height/2-vh/2)*-.08).toFixed(1)+'px,0)'}
  })},{passive:true})}

  // App chapters: the phone shows the screen of the chapter in view (desktop)
  var chs=[].slice.call(document.querySelectorAll('.chapter')), shots=[].slice.call(document.querySelectorAll('.shot'));
  if(chs.length&&'IntersectionObserver' in window){
    var co=new IntersectionObserver(function(en){en.forEach(function(e){if(e.isIntersecting){
      var i=e.target.dataset.i;
      chs.forEach(function(c){c.classList.toggle('on',c.dataset.i===i)});
      shots.forEach(function(s){s.classList.toggle('on',s.dataset.i===i)});
    }})},{rootMargin:'-45% 0px -45% 0px'});
    chs.forEach(function(c){co.observe(c)});
  }

  // Secondary loops: poster only for reduced motion or Save-Data
  [].slice.call(document.querySelectorAll('video.loop')).forEach(function(lv){
    var sd=navigator.connection&&navigator.connection.saveData;
    if(reduce||sd){lv.removeAttribute('autoplay');lv.pause()}
  });

  // Waitlist
  var f=document.getElementById('waitlist'), msg=document.getElementById('msg');
  f.addEventListener('submit',function(e){
    e.preventDefault();
    var em=f.email.value.trim();
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)){msg.textContent='That email looks off. Check it and try again.';f.email.focus();return}
    msg.textContent='Saving…';
    fetch(f.action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:em})})
      .then(function(r){if(!r.ok)throw 0; msg.textContent="You're on the list. One email when it opens."; f.reset()})
      .catch(function(){msg.innerHTML='The waitlist isn’t live yet. Nothing was saved. Meanwhile: <a href="/app?mode=demo">try the live demo →</a>'});
  });
})();

// Strava login errors land here (?auth=...): say what happened, once, near the CTA.
(function(){
  var code=new URLSearchParams(location.search).get('auth'); if(!code) return;
  var msg={denied:'Strava login cancelled.',invalid_state:'Login session expired, please try again.',missing_scope:'Allow access to your activities so the plan can use them.',exchange_failed:"Strava refused the connection. The app is limited to the owner's account for now: try the demo."}[code];
  if(!msg) return;
  var p=document.createElement('p'); p.className='sub'; p.setAttribute('role','status'); p.textContent=msg;
  var a=document.querySelector('.hero .actions'); if(a) a.parentNode.insertBefore(p,a.nextSibling);
  history.replaceState({},'','/');
})();
