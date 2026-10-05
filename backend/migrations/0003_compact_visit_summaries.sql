UPDATE documents SET summary=json_object(
 'id',substr(key,7), 'status',status, 'updated',updated,
 'sharedAt',json_extract(summary,'$.sharedAt'), 'sharedBy',substr(COALESCE(json_extract(summary,'$.sharedBy'),''),1,100),
 'fields',json_object('siteName',substr(COALESCE(json_extract(summary,'$.fields.siteName'),''),1,200),
 'siteId',substr(COALESCE(json_extract(summary,'$.fields.siteId'),''),1,100),
 'date',substr(COALESCE(json_extract(summary,'$.fields.date'),''),1,10),
 'technicians',substr(COALESCE(json_extract(summary,'$.fields.technicians'),''),1,500),
 'ticket',substr(COALESCE(json_extract(summary,'$.fields.ticket'),''),1,500))) WHERE type='visit';
