class PlMap extends HTMLElement {
  constructor() {
    super();
    this.map = null;
    this.markers = null;
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

    this.initMap();
  }

  async initMap() {
    // Wait for Leaflet to be available
    if (typeof L === 'undefined') {
      setTimeout(() => this.initMap(), 100);
      return;
    }

    const mapElement = this.shadowRoot.querySelector('#map');
    
    // Initialize map
    this.map = L.map(mapElement).setView([40.7128, -74.0060], 2);

    // Add tile layer
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '(c) OpenStreetMap contributors'
    }).addTo(this.map);

    // Initialize marker cluster group with custom icon function
    this.markers = L.markerClusterGroup({
      chunkedLoading: true,
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

      const marker = L.marker([lat, lng], { count });
      
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

  async handleClusterClick(clickedOn, cluster) {
    
    let coordinates = [];
    if (clickedOn === 'cluster') {
      const markers = cluster.getAllChildMarkers();
      coordinates = markers.map(marker => ({
        lat: marker.getLatLng().lat.toFixed(4),
        lng: marker.getLatLng().lng.toFixed(4)
      }));
    } else { // single marker (i.e. just one gps point)
      coordinates = [{
        lat: cluster.getLatLng().lat.toFixed(4), 
        lng: cluster.getLatLng().lng.toFixed(4)
      }];
    }

    try {
      const response = await fetch('/api/searchByGpsCoordinates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection_id: 1, coordinates })
      });
      const data = await response.json();
      
      // Get click position on the map
      const mapContainer = this.shadowRoot.querySelector('#map');
      const mapRect = mapContainer.getBoundingClientRect();
      const markerPixel = this.map.latLngToContainerPoint(cluster.getLatLng());
      
      let carousel = Object.assign(document.createElement('pl-carousel'), {
        data: data,
        clickX: mapRect.left + markerPixel.x,
        clickY: mapRect.top + markerPixel.y
      });
      
      const appContainer = document.getElementById('app') || document.body;
      appContainer.appendChild(carousel);
    } catch (error) {
      console.error('Error loading GPS data for carousel:', error);
    }
  }

  openItem(uuid) {
    // Dispatch event to open item in slideshow
    this.dispatchEvent(new CustomEvent('pl-map-item-click', {
      detail: { uuid },
      bubbles: true
    }));
  }

  showNoDataMessage() {
    const mapElement = this.shadowRoot.querySelector('#map');
    mapElement.innerHTML = `
      <div style="display: flex; align-items: center; justify-content: center; height: 100%; color: #666;">
        <div style="text-align: center;">
          <h3>No GPS Data Found</h3>
          <p>No photos or videos with GPS coordinates were found in your collection.</p>
        </div>
      </div>
    `;
  }

  showErrorMessage() {
    const mapElement = this.shadowRoot.querySelector('#map');
    mapElement.innerHTML = `
      <div style="display: flex; align-items: center; justify-content: center; height: 100%; color: #666;">
        <div style="text-align: center;">
          <h3>Error Loading Map</h3>
          <p>There was an error loading the GPS data. Please try again.</p>
        </div>
      </div>
    `;
  }
}

customElements.define('pl-map', PlMap);
