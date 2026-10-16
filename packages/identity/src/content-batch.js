/** A checked single-connection transaction; D1 uses CHECK guards inside its atomic batch. */
export function createContentBatch(client){
 if(typeof client.batch==='function')return client.batch.bind(client);
 if(!client.database||!['mysql','postgres'].includes(client.dialect))return null;
 return async commands=>{
  const{dialect,database}=client,connection=dialect==='mysql'?await database.getConnection():await database.connect();let discard=false;
  const run=async(command)=>{if(dialect==='mysql'){const[r]=await connection.execute(command.sql,command.params??[]);return Array.isArray(r)?{rows:r,affectedRows:0}:{rows:[],affectedRows:Number(r.affectedRows)};}const r=await connection.query(command.sql,command.params??[]);return{rows:r.rows,affectedRows:Number(r.rowCount??0)};};
  try{await connection.query('BEGIN');const results=[];for(const command of commands){const result=await run(command);if(command.expectChanges!==undefined&&result.affectedRows!==command.expectChanges)throw Object.assign(Error('CONTENT_CONFLICT'),{code:'CONTENT_CONFLICT'});results.push(result);}await connection.query('COMMIT');return results;}
  catch(error){try{await connection.query('ROLLBACK');}catch{discard=true;}throw error;}finally{if(discard&&dialect==='mysql')connection.destroy();else connection.release(discard);}
 };
}
