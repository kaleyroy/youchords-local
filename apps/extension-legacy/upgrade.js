// Website account page URL
const YOUCHORDS_WEBSITE_ORIGIN = 'https://www.you-chords.com';

// Firebase Functions URL
const FUNCTIONS_URL = 'http://127.0.0.1:8765';
const PLAN_NAMES = {
  free: 'Free',
  basic: 'Basic',
  starter: 'Starter',
  pro: 'Pro'
};
const PLAN_RANK = {
  free: 0,
  basic: 1,
  starter: 2,
  pro: 3
};

function normalizePlan(plan) {
  const value = String(plan || 'free').toLowerCase();
  return PLAN_NAMES[value] ? value : 'free';
}

function getPlanName(plan) {
  return PLAN_NAMES[normalizePlan(plan)] || 'Free';
}

function alreadyPlanMessage(plan) {
  return `You are already on the ${getPlanName(plan)} plan.`;
}

function cancelPendingPlanMessage(plan) {
  return `Your ${getPlanName(plan)} subscription is active until the end of the billing period. You can manage or renew it from your account.`;
}

async function getStoredJwt() {
  try {
    const jwt = localStorage.getItem('youchords_jwt');
    if (jwt) return jwt;
  } catch (e) {}

  if (typeof chrome !== 'undefined' && chrome.storage) {
    return new Promise((resolve) => {
      chrome.storage.local.get(['youchords_jwt'], (result) => {
        resolve(result.youchords_jwt || null);
      });
    });
  }

  return null;
}

function buildWebsiteSessionUrl(path, jwtOverride = '') {
  const url = new URL(path, YOUCHORDS_WEBSITE_ORIGIN);
  if (jwtOverride) {
    url.searchParams.set('jwt', jwtOverride);
  }
  return url.toString();
}

// Get user info from JWT (check both localStorage and chrome.storage)
async function getUserInfo() {
  return new Promise((resolve) => {
    // First try localStorage
    try {
      const jwt = localStorage.getItem('youchords_jwt');
      if (jwt) {
        const payload = JSON.parse(atob(jwt.split('.')[1]));
        resolve({ odI: payload.odI, plan: payload.plan || 'free', email: '' });
        return;
      }
    } catch (e) {}

    // Then try chrome.storage
    if (typeof chrome !== 'undefined' && chrome.storage) {
      chrome.storage.local.get(['youchords_jwt', 'userPlan', 'user', 'odI'], (result) => {
        if (result.youchords_jwt) {
          try {
            const payload = JSON.parse(atob(result.youchords_jwt.split('.')[1]));
            resolve({ odI: payload.odI, plan: payload.plan || 'free', email: result.user?.email || '' });
            return;
          } catch (e) {}
        }
        // Fallback to stored plan
        if (result.userPlan || result.odI) {
          resolve({ 
            odI: result.odI || '', 
            plan: result.userPlan || 'free',
            email: result.user?.email || ''
          });
          return;
        }
        resolve(null);
      });
    } else {
      resolve(null);
    }
  });
}

// Open checkout with user data (secure server-side checkout)
async function openCheckout(plan) {
  const userInfo = await getUserInfo();
  
  if (!userInfo || !userInfo.odI) {
    alert('Please sign in first to upgrade your plan.');
    return;
  }

  const currentPlan = normalizePlan(userInfo.plan);
  const targetPlan = normalizePlan(plan);

  if (currentPlan === targetPlan) {
    alert(alreadyPlanMessage(targetPlan));
    return;
  }

  // Get JWT from storage
  const jwt = await getStoredJwt();

  if (!jwt) {
    alert('Please sign in first to upgrade your plan.');
    return;
  }

  // Find the button and show loading state
  const btn = document.querySelector(`.plan-card[data-plan="${plan}"] .plan-btn`);
  const originalText = btn ? btn.textContent : '';
  
  try {
    if (btn) {
      btn.textContent = 'Preparing Checkout...';
      btn.disabled = true;
    }

    // Call server to create secure checkout
    const response = await fetch(`${FUNCTIONS_URL}/createCheckout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { jwt, plan } })
    });

    const result = await response.json();
    const data = result.result || result;

    if (data.alreadySubscribed) {
      const activePlan = data.currentPlan || targetPlan;
      alert(data.cancelPending ? cancelPendingPlanMessage(activePlan) : alreadyPlanMessage(activePlan));
      if (btn) {
        btn.textContent = `Already ${getPlanName(activePlan)}`;
        btn.disabled = true;
        btn.style.cursor = 'not-allowed';
      }
      return;
    }

    if (data?.success && data?.planChangeUpdated) {
      alert(data.message || `Your ${getPlanName(targetPlan)} plan change was saved.`);
      window.location.reload();
      return;
    }

    if (data.success && data.url) {
      // Redirect to secure checkout URL
      window.location.href = data.url;
    } else {
      throw new Error(data.error || 'Failed to create checkout');
    }

  } catch (error) {
    console.error('Checkout error:', error);
    const message = error?.message && !/^Failed to (create checkout|get checkout URL)$/i.test(error.message)
      ? error.message
      : 'Could not open checkout. Please try again.';
    alert(message);
    if (btn) {
      btn.textContent = originalText;
      btn.disabled = false;
    }
  }
}

// Open YouChords account page for subscription management
async function openAccountPage() {
  const jwt = await getStoredJwt();
  window.open(buildWebsiteSessionUrl('/account', jwt || ''), '_blank');
}

// Update UI based on current plan
async function updatePlanCards() {
  const userInfo = await getUserInfo();
  const currentPlan = normalizePlan(userInfo?.plan);
  const cards = document.querySelectorAll('.plan-card');
  const manageSection = document.getElementById('manage-subscription');
  
  console.log('Current plan:', currentPlan, 'User info:', userInfo);
  
  // Show manage subscription section for paid users
  if (currentPlan !== 'free' && manageSection) {
    manageSection.style.display = 'block';
  }
  
  cards.forEach(card => {
    const cardPlan = card.dataset.plan;
    const btn = card.querySelector('.plan-btn');
    
    if (!btn || !cardPlan) return;

    if (currentPlan === cardPlan) {
      card.classList.add('current');
      btn.textContent = `Already ${getPlanName(cardPlan)}`;
      btn.disabled = true;
      btn.style.cursor = 'not-allowed';
      return;
    }

    if (currentPlan !== 'free') {
      const direction = (PLAN_RANK[cardPlan] || 0) > (PLAN_RANK[currentPlan] || 0)
        ? 'Upgrade'
        : 'Switch';
      btn.textContent = `${direction} to ${getPlanName(cardPlan)}`;
    } else {
      btn.textContent = 'Subscribe Now';
    }

    btn.addEventListener('click', () => openCheckout(cardPlan));
  });
  
  // Add click handler for manage subscription button
  const manageBtn = document.getElementById('manage-btn');
  if (manageBtn) {
    manageBtn.addEventListener('click', openAccountPage);
  }
}

// Run on page load
document.addEventListener('DOMContentLoaded', updatePlanCards);
