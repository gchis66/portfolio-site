import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const client = new DynamoDBClient({});
const db = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.TABLE_NAME || "ResumeViews";

export const handler = async function(event) {
  const primaryKey = "counterID";
  const primaryKeyValue = "1";
  
  try {
    // Atomic increment: increase the 'count' attribute by 1
    const updateResult = await db.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { [primaryKey]: primaryKeyValue },
      UpdateExpression: "ADD #count :inc", 
      ExpressionAttributeNames: { "#count": "count" },
      ExpressionAttributeValues: { ":inc": 1 },
      ReturnValues: "UPDATED_NEW"
    }));

    const newCount = updateResult.Attributes.count;
    
    // Return result with CORS headers
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "https://www.gregorychisholm.com",
        "Access-Control-Allow-Credentials": true
      },
      body: JSON.stringify({ count: newCount })
    };
  } catch (err) {
    console.error("Error updating count:", err);
    return {
      statusCode: 500,
      headers: { "Access-Control-Allow-Origin": "https://www.gregorychisholm.com" },
      body: JSON.stringify({ error: "Failed to update visitor count" })
    };
  }
};