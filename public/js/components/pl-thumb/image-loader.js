export class ImageLoader {
  constructor(component) {
    this.component = component;
    this.dppx = parseFloat(window.devicePixelRatio.toFixed(2));
  }

  paintSrc() {
    if(this.component.isConnected) {
      let img = this.component.shadowRoot.querySelector('img');
      img.onload = function(){
        this.classList.add('ready');
      };
      // console.log(`need ${this.height * this.#dppx} px`)
      // img.src = `https://picsum.photos/id/${this.id}/${Math.round(this.width)}/${Math.round(this.height)}`;
      img.src = `/api/getThumbnail?uuid=${this.component.id}&height=${Math.round(this.component.height)}`
    } 
  }

  paintWidth() {
    if(this.component.isConnected) {
      this.component.shadowRoot.getElementById('container').style.width = this.component.width+'px';
      // img element is not present during initial paint
      if (this.component.shadowRoot.querySelector('img')) {
        this.component.shadowRoot.querySelector('img').style.width = this.component.width+'px';
      }
    }
  }

  paintHeight() {
    if(this.component.isConnected) {
      this.component.shadowRoot.getElementById('container').style.height = this.component.height+'px';
      // img element is not present during initial paint
      if(this.component.shadowRoot.querySelector('img')) {
        this.component.shadowRoot.querySelector('img').style.height = this.component.height+'px';
      }
    }
  }
}