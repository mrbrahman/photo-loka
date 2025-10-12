export class SelectionHandler {
  constructor(component) {
    this.component = component;
  }

  handleSelection = (evt) => {
    this.component.selected = evt.target.checked; // calls the setter
    let checkEvent = new CustomEvent('r3-item-selected', {composed: true, bubbles: true});
    this.component.dispatchEvent(checkEvent);
  }

  paintSelected() {
    if(!this.component.isConnected) {
      return;
    }

    this.component.shadowRoot.querySelector('input[type="checkbox"]').checked = this.component.selected;
  }

  setupSelectionListener() {
    this.component.shadowRoot.querySelector('input[type="checkbox"]')
      .addEventListener('click', this.handleSelection)
    ;
  }

  setupClickListener() {
    this.component.shadowRoot.querySelector('img').addEventListener('click', ()=>{
      console.log('item clicked');
      let clickEvent = new CustomEvent('pl-gallery-item-clicked', {
        composed: true, 
        bubbles: true, 
        detail: {id: this.component.id}
      });

      this.component.dispatchEvent(clickEvent);
    })
  }
}