import {notify, throttle} from '../utils.mjs';
import { updateAlbumName, searchForExistingAlbums } from '../api/albums-api.mjs';

import sheet from "./styles/pl-album-name.css" with { type: "css" };

class PlAlbumName extends HTMLElement {

  #albumName; #albumSelectedValue='none'; #readOnly = false;

  static template = document.createElement('template');
  static {
    this.template.innerHTML = // html
    `
      <!-- tooltip is sticking badly on mobile -->
      <!-- <sl-tooltip content="Toggle Select All" hoist> -->
        <sl-icon id="select-all" class="select-none" name="check-circle"></sl-icon>
      <!-- </sl-tooltip> -->

      <div id="album-name" role="textbox" spellcheck="false"></div>
      
      <div id="edit-controls">
        <sl-icon id="save" name="check-circle-fill"></sl-icon>
        <sl-icon id="cancel" name="x-circle"></sl-icon>
      </div>
    `;
  }

  constructor() {
    super().attachShadow({mode: 'open'}); // sets "this" and "this.shadowRoot"
    this.shadowRoot.adoptedStyleSheets = [sheet];
  }

  connectedCallback() {
    this.shadowRoot.appendChild(this.constructor.template.content.cloneNode(true));

    this.#paintAlbumName();

    this.shadowRoot.getElementById("select-all").addEventListener('click', this.#handleSelectAll);
    
    this.shadowRoot.getElementById("album-name").addEventListener('click', this.#handleClick);
    this.shadowRoot.getElementById("album-name").addEventListener('focus', this.#handleFocus);
    this.shadowRoot.getElementById("album-name").addEventListener('blur', this.#handleBlur);
    this.shadowRoot.getElementById("album-name").addEventListener('keydown', this.#handleKey);
    this.shadowRoot.getElementById("album-name").addEventListener('input', this.#handleInput);

    this.shadowRoot.getElementById("save").addEventListener('click', this.#handleSave);

    this.shadowRoot.getElementById("cancel").addEventListener('click', this.#handleCancel);

  }

  #handleClick = (evt) => {
    if(this.#readOnly) return;
    this.shadowRoot.getElementById('album-name').contentEditable = 'true';
    this.shadowRoot.getElementById('album-name').focus();
  }

  #handleSelectAll = (evt) => {
    // toggle between 'all' and 'none'
    this.#albumSelectedValue = this.#albumSelectedValue == 'all' ? 'none' : 'all';
    this.#paintSelectAllCheckbox();

    let selectAllEvent = new CustomEvent('r3-select-all-clicked', {detail: {select: this.#albumSelectedValue == 'all' ? true : false}})
    this.dispatchEvent(selectAllEvent);
  }

  #handleSave = async (evt) => {
    if(this.shadowRoot.getElementById('album-name').innerText == this.albumName){
      return;
    }

    try {
      await updateAlbumName(1, this.#albumName, this.shadowRoot.getElementById('album-name').innerText);
      // update UI
      this.albumName = this.shadowRoot.getElementById('album-name').innerText;
      this.shadowRoot.getElementById('album-name').blur();
      this.shadowRoot.getElementById('edit-controls').style.visibility = 'hidden';
      notify('Album name updated successfully', 'success');
    } catch(err) {
      if(err.error?.code === "FOLDER_EXISTS"){
        this.dispatchEvent(new CustomEvent('pl-rename-dir-not-empty', {
          detail: {
            newAlbumName: this.shadowRoot.getElementById('album-name').innerText
          }
        }))
      } else {
        notify(`<strong>Error</strong>:</br>${err.error?.code || err.code}`, 'error', -1);
      }
    }
  }

  #handleCancel = (evt) => {
    if(this.shadowRoot.getElementById('album-name').innerText != this.albumName){
      this.shadowRoot.getElementById('album-name').innerText = this.albumName;
    }

    this.shadowRoot.getElementById('album-name').contentEditable = 'false';
    this.shadowRoot.getElementById('album-name').blur();
    this.shadowRoot.getElementById('edit-controls').style.visibility = 'hidden';
    window.getSelection().removeAllRanges();
  }

  // #handleHover = (evt) => {
  //   console.log('in handle hover')
  // }

  #handleFocus = async (evt) => {
    this.shadowRoot.getElementById('edit-controls').style.visibility = 'visible';

    // position to cursor to enable easy editing
    let len = this.albumName.length;
    let tbd = this.albumName.search(/(Sush Phone |Shreyas Phone )?TBD/g);

    if(tbd>0){
      var range = document.createRange();
      var sel = window.getSelection();
  
      let albumNameText = this.shadowRoot.getElementById('album-name').childNodes[0];
  
      range.setStart(albumNameText, tbd >=0? tbd : len);
      range.setEnd(albumNameText, len);
      sel.removeAllRanges();
      sel.addRange(range);

      let searchStr = albumNameText.textContent.substring(0,15);
      try {
        let output = await searchForExistingAlbums(searchStr, true);
        let rows = output.map(d=>`${d.similar}: ${d.cnt}`);
        if (rows.length > 0){
          notify(rows.join('<BR>'), 'info', 5000);
        }
      } catch(err) {
        notify(`<strong>Error</strong>:</br>${err.error?.message || err}`, 'error', -1);
      }
    }

  }

  #handleBlur = (evt) => {
    // disable contentEditable when focus is lost
    this.shadowRoot.getElementById('album-name').contentEditable = 'false';
    
    // if there are changes made to album name and not saved, notify, else silently remove 
    if(this.shadowRoot.getElementById('album-name').innerText == this.albumName){
      this.shadowRoot.getElementById('edit-controls').style.visibility = 'hidden';
    }
    // else ... ideally notify that user needs to save, however, 
    // cannot notify here since blur is called even when save is pressed (before save is called)
  }

  #throttleKeyDown = throttle(()=>{
    let txt = this.shadowRoot.getElementById('album-name').innerText
    // need at least 2 charcters to perform lookup
    // TODO: remove hardcoding
    if(!txt.includes('TBD') && txt.trim().length > 16){
      this.#suggestAlbumNames(txt)
    }
  }, 1000)

  #suggestAlbumNames = async (txt) => {
    try {
      let output = await searchForExistingAlbums(txt.substring(15).trim(), false);
      let rows = output.map(d=>`${d.similar}: ${d.cnt}`);
      if (rows.length > 0){
        notify(rows.join('<BR>'), 'info', 5000);
      }
    } catch(err) {
      notify(`<strong>Error</strong>:</br>${err.error?.message || err}`, 'error', -1);
    }
  }

  #handleInput = (evt) => {
    this.#throttleKeyDown();
  }

  #handleKey = (evt) => {
    if (evt.key == "Escape"){
      evt.stopPropagation();
      this.#handleCancel();
    } else if(evt.key == "Enter"){
      evt.preventDefault(); // we don't want an actual \n in the album name
      this.#handleSave();
    }
  }

  disconnectedCallback() {
    //implementation
  }

  attributeChangedCallback(name, oldVal, newVal) {
    //implementation
  }

  adoptedCallback() {
    //implementation
  }

  #paintAlbumName() {
    this.shadowRoot.getElementById('album-name').innerText = this.#albumName;
  }

  #paintSelectAllCheckbox(){
    let classes = ['select-none','select-some','select-all'];
    let checkbox = this.shadowRoot.getElementById('select-all');

    switch(this.#albumSelectedValue){
      case 'none':
        checkbox.name = "check-circle";
        checkbox.classList.remove(...classes);
        checkbox.classList.add('select-none');
        break;
      case 'some':
        checkbox.name = "check-circle-fill";
        checkbox.classList.remove(...classes);
        checkbox.classList.add('select-some');
        break;     
      case 'all':
        checkbox.name = "check-circle-fill";
        checkbox.classList.remove(...classes);
        checkbox.classList.add('select-all');
        break;
    }
  }

  get albumName() {
    return this.#albumName;
  }
  set albumName(_) {
    this.#albumName = _;

    if(this.isConnected){
      this.#paintAlbumName();
    }
  }

  get albumSelectedValue() {
    return this.#albumSelectedValue;
  }
  set albumSelectedValue(_){
    this.#albumSelectedValue = _;
    
    if(this.isConnected){
      this.#paintSelectAllCheckbox();
    }
  }
  get readOnly() { return this.#readOnly; }
  set readOnly(_) { this.#readOnly = Boolean(_); }

}

window.customElements.define('pl-album-name', PlAlbumName);
