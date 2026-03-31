import sheet from "./styles/pl-map.css" with { type: "css" };
import leafletSheet from "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" with { type: "css" };

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

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.adoptedStyleSheets = [sheet, leafletSheet];
    this.map = null;
    this.markers = null;
    this.activeMarkerEl = null;
  }

  connectedCallback() {
    this.shadowRoot.appendChild(this.constructor.template.content.cloneNode(true));

    this.shadowRoot.getElementById('gallery-close').addEventListener('click', () => {
      this.closeGalleryPanel();
    });

    this.shadowRoot.getElementById('gallery-expand').addEventListener('click', () => {
      this.toggleExpand();
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
    this.map = L.map(mapElement).setView([40.7128, -74.0060], 2);

    // Add tile layer
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '(c) OpenStreetMap contributors'
    }).addTo(this.map);

    // Initialize marker cluster group with custom icon function
    this.markers = L.markerClusterGroup({
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
    this.markers.on('clusterclick', (e) => {
      this.handleClusterClick('cluster', e.layer);
    });
    this.markers.on('click', (e) => {
      this.handleClusterClick('marker', e.layer);
    });

    // Fetch and display GPS coordinates
    await this.loadGpsData();
  }

  async loadGpsData() {
    try {
      const response = await fetch('/api/getGpsCoordinates');
      const data = await response.json();
      
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
      
      // Create popup content
      const popupContent = this.createPopupContent(item);
      marker.bindPopup(popupContent);
      marker.on('mouseover', function(e) {
        this.openPopup();
      });
      marker.on('mouseout', function(e) {
        this.closePopup();
      });

      this.markers.addLayer(marker);
    });

    this.map.addLayer(this.markers);

    // Fit map to show all markers
    if (bounds.length > 0) {
      this.map.fitBounds(bounds, { padding: [20, 20] });
    }
  }

  createPopupContent(item) {
    return `
      <div class="custom-popup">
        <div class="info">
          <div class="album">${item.count} photos at this location</div>
          <div>Lat: ${item.lat}, Lng: ${item.lng}</div>
        </div>
      </div>
    `;
  }

  setActiveMarker(layer) {
    // Remove previous active marker highlight
    if (this.activeMarkerEl) {
      this.activeMarkerEl.classList.remove('marker-active');
    }

    // Get the icon DOM element for the clicked marker/cluster
    const el = layer.getElement?.();
    if (el) {
      el.classList.add('marker-active');
      this.activeMarkerEl = el;
    }
  }

  async handleClusterClick(clickedOn, cluster) {
    const latlng = cluster.getLatLng();

    let coordinates = [];
    if (clickedOn === 'cluster') {
      const markers = cluster.getAllChildMarkers();
      coordinates = markers.map(marker => ({
        lat: marker.getLatLng().lat.toFixed(4),
        lng: marker.getLatLng().lng.toFixed(4)
      }));
    } else {
      coordinates = [{
        lat: latlng.lat.toFixed(4), 
        lng: latlng.lng.toFixed(4)
      }];
    }

    // Highlight the clicked marker/cluster
    this.setActiveMarker(cluster);

    try {
      const response = await fetch('/api/searchByGpsCoordinates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection_id: 1, coordinates })
      });
      const data = await response.json();

      this.showGalleryPanel(data, latlng);
    } catch (error) {
      console.error('Error loading GPS data for gallery:', error);
    }
  }

  showGalleryPanel(data, latlng) {
    const container = this.shadowRoot.getElementById('container');
    const wrapper = this.shadowRoot.getElementById('gallery-wrapper');
    const isFirstOpen = !container.classList.contains('split');

    // Update header text
    this.shadowRoot.getElementById('gallery-title').textContent =
      `Photos near (${latlng.lat.toFixed(4)}, ${latlng.lng.toFixed(4)})`;

    // Clear previous gallery
    wrapper.innerHTML = '';

    if (isFirstOpen) {
      // Show the panel first so it gets dimensions
      container.classList.add('split');

      // Defer gallery creation to next frame so the panel has its final dimensions
      requestAnimationFrame(() => {
        wrapper.appendChild(Object.assign(document.createElement('pl-gallery'), { data }));
      });
    } else {
      // Panel already visible - safe to create gallery immediately
      wrapper.appendChild(Object.assign(document.createElement('pl-gallery'), { data }));
    }

    setTimeout(() => {
      this.map.invalidateSize();
      this.map.panTo(latlng);
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
    if (this.activeMarkerEl) {
      this.activeMarkerEl.classList.remove('marker-active');
      this.activeMarkerEl = null;
    }

    setTimeout(() => {
      this.map.invalidateSize();
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
        this.map.invalidateSize();
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
