export class RatingHandler {
  constructor(component) {
    this.component = component;
  }

  paintRating() {
    if(this.component.isConnected) {
      this.component.shadowRoot.querySelector('sl-rating').value = this.component.rating;
      
      if(this.component.rating > 0) {
        this.component.shadowRoot.querySelector('sl-rating').style.visibility = "visible";
      } else {
        this.component.shadowRoot.querySelector('sl-rating').style.visibility = "hidden";
      }
    }
  }
}