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
  return info.lastInsertRowid;
}

export async function getAllFrames(){
  const output = await asyncAll(`
    select frame_id, frame_ip_addr, frame_name, collection_id, search_str, display_order, reset_schedule
    from frames
  `);
  return output;
}

export async function getFrame(frame_id){
  const output = await asyncGet(`
    select frame_id, frame_ip_addr, frame_name, collection_id, search_str, display_order, reset_schedule
    from frames where frame_id = ?
  `, frame_id);
  return output;
}

export async function updateFrame(frame_id, entry){
  const info = await asyncRun(`
    update frames
    set frame_ip_addr = @frame_ip_addr,
      frame_name = @frame_name,
      collection_id = @collection_id,
      search_str = @search_str,
      display_order = @display_order,
      reset_schedule = @reset_schedule
    where frame_id = @frame_id
  `, Object.assign({}, entry, {frame_id}));
  return info.changes;
}

export async function deleteFrame(frame_id){
  const info = await asyncRun(`
    delete from frames where frame_id = ?
  `, frame_id);
  return info.changes;
}
