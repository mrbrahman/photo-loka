import { MapInitializer } from './map-initializer.js';
import { DataLoader } from './data-loader.js';
import { MarkerHandler } from './marker-handler.js';
import { MessageHandler } from './message-handler.js';

class PlMap extends HTMLElement {
  constructor() {
    super();
    this.map = null;
    this.markers = null;
    
    // Initialize helpers
    this.mapInitializer = new MapInitializer(this);
    this.dataLoader = new DataLoader(this);
    this.markerHandler = new MarkerHandler(this);
    this.messageHandler = new MessageHandler(this);
  }

  connectedCallback() {
    // Create shadow root
    if (!this.shadowRoot) {
      this.attachShadow({ mode: 'open' });
    }
    this.shadowRoot.innerHTML = `
      <!-- Leaflet CSS -->
      <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
      <!-- Leaflet MarkerCluster CSS -->
      <link rel="stylesheet" href="https://unpkg.com/leaflet.markercluster@1.4.1/dist/MarkerCluster.css" />
      <link rel="stylesheet" href="https://unpkg.com/leaflet.markercluster@1.4.1/dist/MarkerCluster.Default.css" />
      
      <style>
        #map-container {
          width: 100%;
          height: 100%;
          position: relative;
        }
        #map {
          width: 100%;
          height: 100%;
        }
        .custom-popup {
          max-width: 200px;
        }
        .custom-popup img {
          width: 100%;
          height: 120px;
          object-fit: cover;
          border-radius: 4px;
        }
        .custom-popup .info {
          padding: 8px 0;
          font-size: 12px;
        }
        .custom-popup .album {
          font-weight: bold;
          margin-bottom: 4px;
        }
      </style>
      <div id="map-container">
        <div id="map"></div>
      </div>
    `;

    this.mapInitializer.initMap();
  }

  openItem(uuid) {
    // Dispatch event to open item in slideshow
    this.dispatchEvent(new CustomEvent('pl-map-item-click', {
      detail: { uuid },
      bubbles: true
    }));
  }
}

window.customElements.define('pl-map', PlMap);