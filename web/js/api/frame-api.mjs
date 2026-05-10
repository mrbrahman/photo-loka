// Public frame endpoints (no auth required)

export async function getNextFrameItem() {
  let res = await fetch('/frame/getNext');
  let output = await res.json();

  if (!res.ok) {
    if (res.status === 423) {
      throw { message: output.error?.message || 'Frame is paused' };
    }
    throw new Error(output.error?.message || `Server error: ${res.status}`);
  }

  return output;
}
