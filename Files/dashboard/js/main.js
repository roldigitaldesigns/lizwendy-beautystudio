const SERVICE_CADENCE_DAYS = {
  'Nails': 21,
  'Lash Ext': 18,
  'Waxing': 28,
  'Facials': 35,
  'Makeup': 60,
  'PMU': 180,
  'Other': 30
};

function openClientDossier(c) {
  const drawer = document.getElementById('client-drawer');
  const backdrop = document.getElementById('drawer-backdrop');
  if (!drawer) return;

  drawer.hidden = false;
  backdrop.hidden = false;
  requestAnimationFrame(() => {
    drawer.classList.add('is-open');
    backdrop.classList.add('is-open');
    drawer.setAttribute('aria-hidden', 'false');
  });

  $('#drawer-client-name').textContent = c.display_name || 'Unnamed Client';
  const meta = $('#drawer-client-meta');
  clear(meta);
  meta.append(
    h('span', { class: `tag ${c.segment === 'returning' ? 'tag-returning' : 'tag-new'}` }, c.segment === 'returning' ? 'Returning' : 'New'),
    h('span', { class: 'tag' }, c.locale === 'es' ? 'Spanish' : 'English')
  );

  const ltvVal = num(c.ltv_cents);
  const visitsVal = num(c.visits) || 1;
  const avgTicket = Math.round(ltvVal / visitsVal);
  $('#drawer-ltv').textContent = money(ltvVal, cur());
  $('#drawer-visits').textContent = int(visitsVal);
  $('#drawer-avg-ticket').textContent = money(avgTicket, cur());

  const latest = c.last_appointment_at;
  const dslv = getDslv(latest);
  const primaryCat = c.primary_category || 'Nails';
  const cadenceExpected = SERVICE_CADENCE_DAYS[primaryCat] || 30;
  
  $('#drawer-last-service').textContent = `${primaryCat} · ${dslv != null ? `${dslv}d ago` : 'None recorded'}`;
  const badge = $('#drawer-cadence-badge');
  clear(badge);

  if (isUpcoming(c)) {
    badge.className = 'tag tag-upcoming';
    badge.textContent = 'Scheduled';
  } else if (dslv == null) {
    badge.className = 'tag';
    badge.textContent = 'New Client';
  } else {
    const delta = dslv - cadenceExpected;
    if (delta <= 0) {
      badge.className = 'tag tag-active';
      badge.textContent = 'On Schedule';
    } else if (delta <= 7) {
      badge.className = 'tag tag-due';
      badge.textContent = `Due (+${delta}d)`;
    } else {
      badge.className = 'tag tag-risk';
      badge.textContent = `At Risk (+${delta}d overdue)`;
    }
  }

  const affinityBar = $('#drawer-affinity-bar');
  const affinityLegend = $('#drawer-affinity-legend');
  clear(affinityBar);
  clear(affinityLegend);
  
  const barSeg = h('div', { class: 'cat-seg cat-bg-nails', style: 'width: 100%' });
  affinityBar.append(barSeg);
  affinityLegend.textContent = `${primaryCat} (100% of booked volume)`;

  const copyBtn = $('#btn-copy-link');
  const confirmMsg = $('#copy-confirm');
  confirmMsg.hidden = true;
  copyBtn.onclick = () => {
    const link = `https://lizwendybeautystudiollc.com/book?client=${encodeURIComponent(c.phone)}&lang=${c.locale || 'en'}`;
    navigator.clipboard.writeText(link).then(() => {
      confirmMsg.hidden = false;
      setTimeout(() => { confirmMsg.hidden = true; }, 2500);
    });
  };

  const bookBtn = $('#btn-in-house-book');
  bookBtn.onclick = () => {
    window.location.hash = `#book?client=${encodeURIComponent(c.phone)}`;
  };
}
