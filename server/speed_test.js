async function getReliableQuality() {
  // Check if we already decided during this session
  //if (sessionStorage.getItem('videoQuality')) return sessionStorage.getItem('videoQuality');

  const results = [];
  for (let i = 0; i < 3; i++) {
    results.push(await determineVideoQuality());
  }

  // If even one test passed as 'original', the pipe is capable of it
  const finalQuality = results.includes('original') ? 'original' : 'compressed';
  sessionStorage.setItem('videoQuality', finalQuality);
  return finalQuality;
}

async function determineVideoQuality() {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 300); // LAN threshold

  const start = performance.now();
  try {
    // warm up the connection
    await fetch('/ping', { method: 'HEAD' });
    
    const response = await fetch('/speed-test', { 
      signal: controller.signal,
      cache: 'no-store' 
    });
    
    await response.arrayBuffer(); // Wait for full download
    const duration = performance.now() - start;
    
    console.log(`Speed test finished in ${duration.toFixed(0)}ms`);
    return 'original'; // It finished under 150ms
  } catch (err) {
    if (err.name === 'AbortError') {
      console.log('Speed test timed out: Switching to compressed');
    } else {
      console.log('Speed test failed:', err);
    }
    return 'compressed';
  } finally {
    clearTimeout(timeoutId);
  }
}
