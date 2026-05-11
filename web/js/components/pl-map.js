import sheet from "./styles/pl-map.css" with { type: "css" };
import leafletSheet from "leaflet-css" with { type: "css" };
import { getGpsCoordinates } from '../api/search-api.mjs';
import { notify } from '../utils.mjs';

class PlMap extends HTMLElement {

  static template = document.createElement('template');
  static {
    this.template.innerHTML = // html
    `
      <!-- Leaflet CSS -->
      <!-- Leaflet MarkerCluster CSS -->
      <link rel="stylesheet" href="https://unpkg.com/leaflet.markercluster@1.4.1/dist/MarkerCluster.css" />
      <link rel="stylesheet" href="https://unpkg.com/leaflet.markercluster@1.4.1/dist/MarkerCluster.Default.css" />
      
      <div id="container">
        <div id="map"></div>
        <button id="locate-btn" title="Zoom to my location" aria-label="Zoom to my location">
          <sl-icon name="geo-alt-fill"></sl-icon>
        </button>
        <div id="gallery-panel">
          <div id="gallery-header">
            <span id="gallery-title"></span>
            <div id="gallery-actions">
              <sl-icon-button id="gallery-expand" name="arrows-fullscreen" label="Expand"></sl-icon-button>
              <sl-icon-button id="gallery-close" name="x-lg" label="Close"></sl-icon-button>
            </div>
          </div>
          <div id="gallery-wrapper"></div>
        </div>
      </div>
    `;
  }

  #map = null;
  #markers = null;
  #activeMarkerEl = null;
  #userLocationZoom = 15;

  constructor() {
    super().attachShadow({ mode: 'open' });
    this.shadowRoot.adoptedStyleSheets = [sheet, leafletSheet];
  }

  connectedCallback() {
    this.shadowRoot.appendChild(this.constructor.template.content.cloneNode(true));

    this.shadowRoot.getElementById('gallery-close').addEventListener('click', () => {
      this.closeGalleryPanel();
    });

    this.shadowRoot.getElementById('gallery-expand').addEventListener('click', () => {
      this.toggleExpand();
    });

    this.shadowRoot.getElementById('locate-btn').addEventListener('click', () => {
      this.#zoomToUserLocation();
    });

    this.initMap();
  }

  async initMap() {
    // Wait for Leaflet to be available
    if (typeof L === 'undefined') {
      setTimeout(() => this.initMap(), 100);
      return;
    }

    const mapElement = this.shadowRoot.getElementById('map');
    
    // Initialize map
    this.#map = L.map(mapElement).setView([40.7128, -74.0060], 2);

    // Add tile layer
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '(c) OpenStreetMap contributors'
    }).addTo(this.#map);

    // Initialize marker cluster group with custom icon function
    this.#markers = L.markerClusterGroup({
      chunkedLoading: true,
      removeOutsideVisibleBounds: false,
      maxClusterRadius: 50,
      zoomToBoundsOnClick: false,
      spiderfyOnMaxZoom: false,
      iconCreateFunction: function(cluster) {
        const markers = cluster.getAllChildMarkers();
        const totalCount = markers.reduce((sum, marker) => sum + (marker.options.count || 1), 0);
        
        return new L.DivIcon({
          html: `<div><span>${totalCount}</span></div>`,
          className: `marker-cluster marker-cluster-${totalCount < 10 ? 'small' : totalCount < 100 ? 'medium' : 'large'}`,
          iconSize: new L.Point(40, 40)
        });
      }
    });

    // Add cluster click handler
    this.#markers.on('clusterclick', (e) => {
      this.handleClusterClick('cluster', e.layer);
    });
    this.#markers.on('click', (e) => {
      this.handleClusterClick('marker', e.layer);
    });

    // Fetch and display GPS coordinates
    await this.loadGpsData();
  }

  async loadGpsData() {
    try {
      const data = await getGpsCoordinates();
      
      if (data.length === 0) {
        this.showNoDataMessage();
        return;
      }

      this.addMarkersToMap(data);
      
    } catch (error) {
      console.error('Error loading GPS data:', error);
      this.showErrorMessage();
    }
  }

  async #zoomToUserLocation() {
    if (!navigator.geolocation) return;

    const btn = this.shadowRoot.getElementById('locate-btn');

    // Check permission state to decide when to show loading feedback
    let permState = 'unknown';
    if (navigator.permissions) {
      try {
        const status = await navigator.permissions.query({ name: 'geolocation' });
        permState = status.state;

        if (permState === 'prompt') {
          // Show feedback only after user grants permission
          status.addEventListener('change', () => {
            if (status.state === 'granted') btn.classList.add('locating');
          }, { once: true });
        }
      } catch (e) {
        // Permissions API not supported - fall through
      }
    }

    // If already granted, show feedback immediately
    if (permState === 'granted') btn.classList.add('locating');

    navigator.geolocation.getCurrentPosition(
      (position) => {
        btn.classList.remove('locating');
        const { latitude, longitude } = position.coords;
        this.#map.setView([latitude, longitude], this.#userLocationZoom);
      },
      (error) => {
        btn.classList.remove('locating');
        const messages = {
          1: 'Location permission denied',
          2: 'Location unavailable',
          3: 'Location request timed out'
        };
        notify(messages[error.code] || 'Could not get location', 'warning');
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: Infinity }
    );
  }

  addMarkersToMap(items) {
    const bounds = [];

    items.forEach(item => {
      const lat = parseFloat(item.lat);
      const lng = parseFloat(item.lng);
      const count = parseInt(item.count);
      
      if (isNaN(lat) || isNaN(lng)) return;

      bounds.push([lat, lng]);

      const sizeClass = count < 10 ? 'small' : count < 100 ? 'medium' : 'large';
      const marker = L.marker([lat, lng], {
        count,
        icon: new L.DivIcon({
          html: `<div><span>${count}</span></div>`,
          className: `marker-cluster marker-cluster-${sizeClass}`,
          iconSize: new L.Point(40, 40)
        })
      });
      
      this.#markers.addLayer(marker);
    });

    this.#map.addLayer(this.#markers);

    // Fit map to show all markers
    if (bounds.length > 0) {
      this.#map.fitBounds(bounds, { padding: [20, 20] });
    }
  }

  setActiveMarker(layer) {
    // Remove previous active marker highlight
    if (this.#activeMarkerEl) {
      this.#activeMarkerEl.classList.remove('marker-active');
    }

    // Get the icon DOM element for the clicked marker/cluster
    const el = layer.getElement?.();
    if (el) {
      el.classList.add('marker-active');
      this.#activeMarkerEl = el;
    }
  }

  async handleClusterClick(clickedOn, cluster) {
    const latlng = cluster.getLatLng();

    let bounds;
    if (clickedOn === 'cluster') {
      const b = cluster.getBounds();
      bounds = {
        sw: { lat: b.getSouthWest().lat, lng: b.getSouthWest().lng },
        ne: { lat: b.getNorthEast().lat, lng: b.getNorthEast().lng }
      };
    } else {
      bounds = {
        sw: { lat: latlng.lat, lng: latlng.lng },
        ne: { lat: latlng.lat, lng: latlng.lng }
      };
    }

    // Highlight the clicked marker/cluster
    this.setActiveMarker(cluster);

    this.showGalleryPanel(bounds, latlng);
  }

  showGalleryPanel(bounds, latlng) {
    const container = this.shadowRoot.getElementById('container');
    const wrapper = this.shadowRoot.getElementById('gallery-wrapper');
    const isFirstOpen = !container.classList.contains('split');

    // Update header text
    this.shadowRoot.getElementById('gallery-title').textContent =
      `Photos near (${latlng.lat.toFixed(4)}, ${latlng.lng.toFixed(4)})`;

    // Clear previous gallery
    wrapper.innerHTML = '';

    const gallery = Object.assign(document.createElement('pl-gallery'), {
      mode: 'geo',
      query: { collectionId: 1, bounds }
    });

    if (isFirstOpen) {
      // Show the panel first so it gets dimensions
      container.classList.add('split');

      // Defer gallery creation to next frame so the panel has its final dimensions
      requestAnimationFrame(() => {
        wrapper.appendChild(gallery);
      });
    } else {
      // Panel already visible - safe to create gallery immediately
      wrapper.appendChild(gallery);
    }

    setTimeout(() => {
      this.#map.invalidateSize();
      this.#map.panTo(latlng);
    }, 50);
  }

  closeGalleryPanel() {
    const container = this.shadowRoot.getElementById('container');

    // Clear gallery content
    this.shadowRoot.getElementById('gallery-wrapper').innerHTML = '';

    // Collapse panel and reset expand state
    container.classList.remove('split', 'expanded');

    // Reset expand button icon
    this.shadowRoot.getElementById('gallery-expand').name = 'arrows-fullscreen';

    // Remove active marker highlight
    if (this.#activeMarkerEl) {
      this.#activeMarkerEl.classList.remove('marker-active');
      this.#activeMarkerEl = null;
    }

    setTimeout(() => {
      this.#map.invalidateSize();
    }, 50);
  }

  toggleExpand() {
    const container = this.shadowRoot.getElementById('container');
    const expandBtn = this.shadowRoot.getElementById('gallery-expand');
    const isExpanded = container.classList.toggle('expanded');

    expandBtn.name = isExpanded ? 'fullscreen-exit' : 'arrows-fullscreen';

    if (!isExpanded) {
      // Collapsing back to split - map needs to recalculate
      setTimeout(() => {
        this.#map.invalidateSize();
      }, 50);
    }

    // Gallery needs to re-layout to the new width
    window.dispatchEvent(new Event('resize'));
  }

  showNoDataMessage() {
    const mapElement = this.shadowRoot.getElementById('map');
    mapElement.innerHTML = `
      <div style="display: flex; align-items: center; justify-content: center; height: 100%; color: var(--text-secondary);">
        <div style="text-align: center;">
          <h3>No GPS Data Found</h3>
          <p>No photos or videos with GPS coordinates were found in your collection.</p>
        </div>
      </div>
    `;
  }

  showErrorMessage() {
    const mapElement = this.shadowRoot.getElementById('map');
    mapElement.innerHTML = `
      <div style="display: flex; align-items: center; justify-content: center; height: 100%; color: var(--text-secondary);">
        <div style="text-align: center;">
          <h3>Error Loading Map</h3>
          <p>There was an error loading the GPS data. Please try again.</p>
        </div>
      </div>
    `;
  }
}

customElements.define('pl-map', PlMap);
