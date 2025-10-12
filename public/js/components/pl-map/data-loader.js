export class DataLoader {
  constructor(component) {
    this.component = component;
  }

  async loadGpsData() {
    try {
      const response = await fetch('/api/getGpsCoordinates');
      const data = await response.json();
      
      if (data.length === 0) {
        this.component.messageHandler.showNoDataMessage();
        return;
      }

      this.component.markerHandler.addMarkersToMap(data);
      
    } catch (error) {
      console.error('Error loading GPS data:', error);
      this.component.messageHandler.showErrorMessage();
    }
  }
}