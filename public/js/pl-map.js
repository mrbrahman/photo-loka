class PlMap extends HTMLElement {
  constructor() {
    super();
    this.map = null;
    this.markers = null;
  }

  connectedCallback() {
    this.innerHTML = `
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

    const mapElement = this.querySelector('#map');
    
    // Initialize map
    this.map = L.map(mapElement).setView([40.7128, -74.0060], 2);

    // Add tile layer
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '┬⌐ OpenStreetMap contributors'
    }).addTo(this.map);

    // Initialize marker cluster group
    this.markers = L.markerClusterGroup({
      chunkedLoading: true,
      maxClusterRadius: 50
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
      const lat = parseFloat(item.gps_lat);
      const lng = parseFloat(item.gps_long);
      
      if (isNaN(lat) || isNaN(lng)) return;

      bounds.push([lat, lng]);

      const marker = L.marker([lat, lng]);
      
      // Create popup content
      const popupContent = this.createPopupContent(item);
      marker.bindPopup(popupContent);
      marker.on('mouseover', function(e) {
        this.openPopup();
      });
      marker.on('mouseout', function(e) {
        this.closePopup();
      });

      // Add click handler to open slideshow
      // marker.on('click', () => {
      //   this.openItem(item.uuid);
      // });

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
        <img src="/api/getThumbnail?uuid=${item.uuid}&height=120" 
             alt="${item.filename}" 
             onerror="this.style.display='none'">
        <div class="info">
          <div class="album">${item.album}</div>
          <!--<div>${item.filename}</div>-->
        </div>
      </div>
    `;
  }

  openItem(uuid) {
    // Dispatch event to open item in slideshow
    this.dispatchEvent(new CustomEvent('pl-map-item-click', {
      detail: { uuid },
      bubbles: true
    }));
  }

  showNoDataMessage() {
    const mapElement = this.querySelector('#map');
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
    const mapElement = this.querySelector('#map');
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
