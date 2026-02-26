// Always escape HTML for text arguments!
function escapeHtml(html) {
  const div = document.createElement('div');
  div.textContent = html;
  return div.innerHTML;
}

let info = {variant: 'primary', icon: 'info-circle'};
let success = {variant: 'success', icon: 'check2-circle'};
let warning = {variant: 'warning', icon: 'exclamation-triangle'};
let error = {variant: 'danger', icon: 'exclamation-octagon'};

// Custom function to emit toast notifications
export function notify(message, type='info', duration=3000) {
  // type should be one of: info, success, warning, error
  // if something else is found, just set to info
  let t = type == 'info' ? info : type == 'success' ? success : type == 'warning' ? warning : type == 'error' ? error : info;

  const alert = Object.assign(document.createElement('sl-alert'), {
    variant: t.variant,
    closable: true,
    innerHTML: `
      <sl-icon name="${t.icon}" slot="icon"></sl-icon>
      ${message}
    `
  });

  // for errors, we don't want auto close
  if(duration > 0){
    alert.duration = duration;
  }

  document.body.append(alert);
  return alert.toast();
}

// A simple debounce implementation
// https://www.freecodecamp.org/news/javascript-debounce-example/
export function debounce(func, timeout = 300){
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => { func.apply(this, args); }, timeout);
  };
};

// https://gist.github.com/ionurboz/51b505ee3281cd713747b4a84d69f434
export function throttle(fn, threshhold, scope) {
  threshhold || (threshhold = 250);
  var last,
      deferTimer;
  return function () {
    var context = scope || this;

    var now = +new Date,
        args = arguments;
    if (last && now < last + threshhold) {
      // hold on to it
      clearTimeout(deferTimer);
      deferTimer = setTimeout(function () {
        last = now;
        fn.apply(context, args);
      }, threshhold);
    } else {
      last = now;
      fn.apply(context, args);
    }
  };
}

export function showProgressBar(){
  document.getElementById("progress-bar").toggleAttribute("indeterminate");
  document.getElementById("progress-bar").classList.remove("hide");
}

// hide the progress bar after a specific timeout
export function hideProgressBar(timeout=500){
  setTimeout(()=>{
    document.getElementById("progress-bar").classList.add("hide");
    document.getElementById("progress-bar").toggleAttribute("indeterminate");
  }, timeout)
}

export function showConfirmDialog(title, message, btn1Text='OK', btn2Text='Cancel'){
  return new Promise((resolve) => {
    const dialog = document.createElement('sl-dialog');
    dialog.label = title;
    dialog.innerHTML = `
      ${message}
      <sl-button slot="footer" variant="primary" id="ok">${btn1Text}</sl-button>
      <sl-button slot="footer" id="cancel">${btn2Text}</sl-button>
    `;

    document.body.append(dialog);
    dialog.show();

    // Resolve true on OK, false on Cancel/Close
    dialog.querySelector('#ok').onclick = () => { dialog.hide(); resolve(1); };
    dialog.querySelector('#cancel').onclick = () => { dialog.hide(); resolve(2); };
    
    // Cleanup: remove from DOM after it finishes hiding
    dialog.addEventListener('sl-after-hide', () => {
      dialog.remove();
      resolve(false); // In case it was closed without clicking buttons
    });
  });
};
