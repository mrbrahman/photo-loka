export class MarkerHandler {
  constructor(component) {
    this.component = component;
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

      this.component.markers.addLayer(marker);
    });

    this.component.map.addLayer(this.component.markers);

    // Fit map to show all markers
    if (bounds.length > 0) {
      this.component.map.fitBounds(bounds, { padding: [20, 20] });
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
      const mapContainer = this.component.shadowRoot.querySelector('#map');
      const mapRect = mapContainer.getBoundingClientRect();
      const markerPixel = this.component.map.latLngToContainerPoint(cluster.getLatLng());
      
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
}