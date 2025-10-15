import { notify } from '#utils';
import { LayoutManager } from './layout-manager.js';
import { NavigationController } from './navigation-controller.js';
import { ThumbRenderer } from './thumb-renderer.js';

class PlCarousel extends HTMLElement {

  #data = []; currentIndex = 0; layout = [];
  
  constructor() {
    super().attachShadow({mode: 'open'}); // sets "this" and "this.shadowRoot"
    
    // Initialize helpers
    this.layoutManager = new LayoutManager(this);
    this.navigationController = new NavigationController(this);
    this.thumbRenderer = new ThumbRenderer(this);
  }

  connectedCallback() {
    this.shadowRoot.appendChild(
      document.getElementById(this.nodeName).content.cloneNode(true)
    );

    this.setupEventListeners();
    this.layoutManager.positionCarousel();
    this.thumbRenderer.render();
  }

  setupEventListeners() {
    // Close on escape key
    document.addEventListener('keydown', this.handleKeydown);
    
    // Close on outside click
    document.addEventListener('click', this.handleOutsideClick);
    
    // Handle thumb clicks
    this.shadowRoot.addEventListener('click', this.handleThumbClick);
    
    // Navigation buttons
    this.shadowRoot.getElementById('prev-btn').addEventListener('click', (e) => { e.stopPropagation(); this.navigationController.navigate(-1); });
    this.shadowRoot.getElementById('next-btn').addEventListener('click', (e) => { e.stopPropagation(); this.navigationController.navigate(1); });
    this.shadowRoot.getElementById('close-btn').addEventListener('click', (e) => { e.stopPropagation(); this.close(); });
  }

  handleKeydown = (e) => {
    if (e.key === 'Escape') {
      this.close();
    }
  }

  handleOutsideClick = (e) => {
    if (!this.shadowRoot.getElementById('container').contains(e.target)) {
      this.close();
    }
  }

  handleThumbClick = (e) => {
    if (e.target.tagName === 'PL-THUMB' || e.target.closest('pl-thumb')) {
      e.stopPropagation();
      notify('Feature not yet implemented');
    }
  }

  close() {
    document.removeEventListener('keydown', this.handleKeydown);
    document.removeEventListener('click', this.handleOutsideClick);
    this.remove();
  }

  disconnectedCallback() {
    document.removeEventListener('keydown', this.handleKeydown);
    document.removeEventListener('click', this.handleOutsideClick);
  }

  set data(value) {
    this.#data = value || [];
  }
  
  get data() {
    return this.#data;
  }
  
  set clickX(value) {
    this._clickX = value;
  }
  
  get clickX() {
    return this._clickX;
  }
  
  set clickY(value) {
    this._clickY = value;
  }
  
  get clickY() {
    return this._clickY;
  }

}

window.customElements.define('pl-carousel', PlCarousel);