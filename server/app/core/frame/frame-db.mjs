import { asyncGet, asyncAll, asyncRun } from '#db/db-pool';
import { createLogger } from '#utils/logger';

const logger = createLogger(import.meta.url);

const insertIntoFramesStatement = `
insert into frames
(  frame_ip_addr, frame_name, collection_id, search_str, display_order, reset_schedule )
values
(  @frame_ip_addr, @frame_name, @collection_id, @search_str, @display_order, @reset_schedule )
`;

export async function createNewFrame(entry){
  const info = await asyncRun(insertIntoFramesStatement, entry);
  return entry.frame_ip_addr;
}

export async function getAllFrames(){
  const output = await asyncAll(`
    select frame_ip_addr, frame_name, collection_id, search_str, display_order, reset_schedule
    from frames
  `);
  return output;
}

export async function getFrame(frame_ip_addr){
  const output = await asyncGet(`
    select frame_ip_addr, frame_name, collection_id, search_str, display_order, reset_schedule
    from frames where frame_ip_addr = ?
  `, frame_ip_addr);
  return output;
}

export async function updateFrame(frame_ip_addr, entry){
  const info = await asyncRun(`
    update frames
    set frame_name = @frame_name,
      collection_id = @collection_id,
      search_str = @search_str,
      display_order = @display_order,
      reset_schedule = @reset_schedule
    where frame_ip_addr = @frame_ip_addr
  `, Object.assign({}, entry, {frame_ip_addr}));
  return info.changes;
}

export async function deleteFrame(frame_ip_addr){
  const info = await asyncRun(`
    delete from frames where frame_ip_addr = ?
  `, frame_ip_addr);
  return info.changes;
}
