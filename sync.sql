.param init
.param set @tgt_base '/media/shreyas/${drive}/'
.param set @last_sync_id "${last_sync_id}"
.param set @curr_max_id "${curr_max_id}"

.param set @src_base '/media/shreyas/Extreme SSD/'

select
  case 
    when action = 'create-dir' then 
      'mkdir -pv '''|| replace(path1, @src_base, @tgt_base) || '''' || 
      ' && touch -t '|| strftime('%Y%m%d%H%M.%S', action_tm) || ' ''' || replace(path1, @src_base, @tgt_base) || ''''
    when action = 'delete' then
      'rm -v ''' || replace(path1, @src_base, @tgt_base) || ''''
    when action = 'move' then
      case when path1 like @src_base||'%' then
        -- dir / file renamed
        'mv -nv ''' || replace(path1, @src_base, @tgt_base) || ''' ''' || replace(path2, @src_base, @tgt_base) || ''''
      else
        -- new file
        'cp -npv ''' || path2 || ''' ''' || replace(path2, @src_base, @tgt_base) || ''''
      end
    when action = 'in-place' then
      'cp -npv ''' || path1 || ''' ''' || replace(path1, @src_base, @tgt_base) || ''''
  end as cmd
from file_audit_log
where id > @last_sync_id
and id <= @curr_max_id
order by id
;
