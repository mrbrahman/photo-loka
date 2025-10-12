export class MapInitializer {
  constructor(component) {
    this.component = component;
  }

  async initMap() {
    // Wait for Leaflet to be available
    if (typeof L === 'undefined') {
      setTimeout(() => this.initMap(), 100);
      return;
    }

    const mapElement = this.component.shadowRoot.querySelector('#map');
    
    // Initialize map
    this.component.map = L.map(mapElement).setView([40.7128, -74.0060], 2);

    // Add tile layer
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '(c) OpenStreetMap contributors'
    }).addTo(this.component.map);

    // Initialize marker cluster group with custom icon function
    this.component.markers = L.markerClusterGroup({
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
    this.component.markers.on('clusterclick', (e) => {
      this.component.markerHandler.handleClusterClick('cluster', e.layer);
    });
    this.component.markers.on('click', (e) => {
      this.component.markerHandler.handleClusterClick('marker', e.layer);
    });

    // Fetch and display GPS coordinates
    await this.component.dataLoader.loadGpsData();
  }
}