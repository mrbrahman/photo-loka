// Always escape HTML for text arguments!
function escapeHtml(html) {
  const div = document.createElement('div');
  div.textContent = html;
  return div.innerHTML;
}

// TODO: standardize this for info, warnings, errors etc.

// Custom function to emit toast notifications
export function notify(message, variant = 'primary', icon = 'info-circle', duration = 3000) {
  const alert = Object.assign(document.createElement('sl-alert'), {
    variant,
    closable: true,
    innerHTML: `
      <sl-icon name="${icon}" slot="icon"></sl-icon>
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