import {notify} from '#utils';

export class RatingManager {
  constructor(component) {
    this.component = component;
  }

  handleRatingChanged = (evt) => {
    let item = this.component.item, newRating = evt.target.value;
    console.log(item);

    if(item.data.rating == newRating){
      return;
    }

    fetch('/api/updateRating', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        uuid_arr: [item.data.id],
        newRating: evt.detail.newRating
      })
    })
    .then(res=>{
      if(!res.ok){
        throw `${res.status} ${res.statusText}`
      }
    })
    // Update in backend successful, now update the UI
    .then(()=>{
      // update data
      item.data.rating = newRating;

      // update element if one was created
      if(item.elem){
        // there is no listener on the rating element, so we can 
        // safely update here
        item.elem.rating = newRating;
      }

      notify(`Updated rating for this item`, 'success');
    })
    .catch(err=>{
      notify(`<strong>Error</strong>:</br>${err}`, 'error', -1);

      // revert rating on screen (extra for this flow)
      this.component.shadowRoot.getElementById('rating').value = item.data.rating;
    });
  }

  setupRatingListener() {
    this.component.shadowRoot.getElementById('rating').addEventListener('sl-change', this.handleRatingChanged);
  }
}