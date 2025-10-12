// Simple user state management for selections like collection_id
class UserState {
  constructor() {
    this.state = this.loadState();
  }

  loadState() {
    try {
      const saved = localStorage.getItem('rewind-replay-state');
      return saved ? JSON.parse(saved) : { collection_id: 1 };
    } catch {
      return { collection_id: 1 };
    }
  }

  saveState() {
    localStorage.setItem('rewind-replay-state', JSON.stringify(this.state));
  }

  get(key) {
    return this.state[key];
  }

  set(key, value) {
    this.state[key] = value;
    this.saveState();
  }

  getCollectionId() {
    return this.state.collection_id;
  }

  setCollectionId(id) {
    this.set('collection_id', id);
  }
}

export const userState = new UserState();