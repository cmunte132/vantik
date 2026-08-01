/**
 * The prompt that turns a bug report into a resolution guide.
 *
 * Moved verbatim from `actions/bug-enricher/utils.ts`. Kept in its own file
 * because a prompt is content, and mixing it into the handler makes both
 * harder to read and the prompt harder to iterate on.
 */
export const PARTIAL_SOLUTION_PROMPT = `[TASK]
[TASK] Given a bug report related to software development, create a detailed, multi-step resolution guide tailored for developers with intermediate to advanced expertise. The guide should be structured and clear, aiding in both understanding and fixing the issue effectively. Steps should consist of:
1. **Bug Restatement and Clarification:** Start by explicating the reported bug to ensure its nature is clearly understood.
2. **Step-by-Step Troubleshooting Guide:**
   - List the steps for diagnosing the issue.
   - Describe specific corrective actions, systematically addressing different facets of the bug.
   - Use bullet points or numbered lists for clarity and sequence.
3. **Code Modifications and Examples:**
   - Provide relevant code snippets showing necessary changes.
   - Ensure the examples reflect commonly used programming libraries or frameworks to illustrate real-world application of the fixes.
4. **Conclusion:** Summarize the strategy to reassure understanding and provide closure on the troubleshooting process.
5. **Output Formatting:** Present your solution in a well-structured format encapsulated within markdown syntax to enhance readability and instructional value. This format should facilitate easy application in software development or educational contexts, enabling swift and efficient debugging.
This detailed guide should maintain a professional tone, focusing on clarity and practical application, serving as a robust resource in advancing debugging skills and software development expertise.
---

[FORMAT]
Follow the following format:

[INPUT]
bug_description: description of the bug encountered in the software
tech_stack: technologies used in the project where the bug occurred
[OUTPUT]
structured formatted solution guide with steps and code snippets to resolve the bug

---

[EXAMPLES]

[Example 1]
[INPUT]
bug_description: Bug: Unable to connect to database due to incorrect database credentials.
tech_stack: Python, Django, PostgreSQL
[OUTPUT]
1. **Identify the Database Settings:**
   - Find the database settings file or function in your Django application where the database credentials are being stored.

2. **Update the Database Credentials:**
   - Change the incorrect database credentials (OLD_USERNAME, OLD_PASSWORD) to the correct ones (NEW_USERNAME, NEW_PASSWORD).

3. **Refactor the Database Connection:**
   - Modify the database connection code to use the correct credentials.

### Example Code Update

Here’s an example assuming you are using django.db:

\`\`\`python
# Before: Incorrect database credentials
DATABASES = {
    'default': {
        'ENGINE': 'django.db.backends.postgresql',
        'NAME': 'mydatabase',
        'USER': 'OLD_USERNAME',
        'PASSWORD': 'OLD_PASSWORD',
        'HOST': 'localhost',
        'PORT': '5432',
    }
}

# After: Corrected database credentials
DATABASES = {
    'default': {
        'ENGINE': 'django.db.backends.postgresql',
        'NAME': 'mydatabase',
        'USER': 'NEW_USERNAME',
        'PASSWORD': 'NEW_PASSWORD',
        'HOST': 'localhost',
        'PORT': '5432',
    }
}\`\`\`
---
[Example 2]
[INPUT]
bug_description: Bug: Error occurs when sending email due to incorrect email configuration.
tech_stack: PHP, Laravel, Mailgun
[OUTPUT]
1. **Identify the Email Configuration:**
   - Find the email configuration file or function in your Laravel application where the email settings are being stored.

2. **Update the Email Configuration:**
   - Change the incorrect email configuration (OLD_MAILGUN_DOMAIN, OLD_MAILGUN_SECRET) to the correct ones (NEW_MAILGUN_DOMAIN, NEW_MAILGUN_SECRET).

3. **Refactor the Email Sending Code:**
   - Modify the email sending code to use the correct email configuration.

### Example Code Update

Here’s an example assuming you are using Laravel Mail:

\`\`\`php
// Before: Incorrect email configuration
 MAIL_MAILER=smtp
 MAIL_HOST=smtp.mailgun.org
 MAIL_PORT=587
 MAIL_USERNAME=postmaster@$OLD_MAILGUN_DOMAIN
 MAIL_PASSWORD=$OLD_MAILGUN_SECRET
 MAIL_ENCRYPTION=tls

// After: Corrected email configuration
 MAIL_MAILER=smtp
 MAIL_HOST=smtp.mailgun.org
 MAIL_PORT=587
 MAIL_USERNAME=postmaster@$NEW_MAILGUN_DOMAIN
 MAIL_PASSWORD=$NEW_MAILGUN_SECRET
 MAIL_ENCRYPTION=tls;\`\`\`
---
[Example 3]
[INPUT]
bug_description: Bug: Error occurs when uploading files due to incorrect file type.
tech_stack: React, Node.js, Express
[OUTPUT]
1. **Identify the File Upload Component:**
   - Find the component or function in your React application where the file upload is being handled.

2. **Update the File Type:**
   - Change the incorrect file type (application/json) to the correct one (multipart/form-data).

3. **Refactor the File Upload:**
   - If you are using the axios library, modify the file upload to use the correct file type.

### Example Code Update

Here’s an example assuming you are using axios:

\`\`\`javascript
// Before: Incorrect file type
import axios from 'axios';

handleFileUpload = (event) => {
  const file = event.target.files[0];
  const formData = new FormData();
  formData.append('file', file);
  axios.post('/upload', formData, {
    headers: {
      'Content-Type': 'application/json',
    },
  })
  .then((response) => {
    console.log(response);
  })
  .catch((error) => {
    console.error(error);
  });
};

// After: Corrected file type
import axios from 'axios';

handleFileUpload = (event) => {
  const file = event.target.files[0];
  const formData = new FormData();
  formData.append('file', file);
  axios.post('/upload', formData, {
    headers: {
      'Content-Type': 'multipart/form-data',
    },
  })
  .then((response) => {
    console.log(response);
  })
  .catch((error) => {
    console.error(error);
  });
};\`\`\`
---
[Example 4]
[INPUT]
bug_description: Bug: Unable to display user profiles due to incorrect API endpoint.
tech_stack: React, Node.js, Express
[OUTPUT]
1. **Identify the Component with the API Call:**
   - Find the component or function in your React application where the API call to /users/profile is being made.

2. **Update the API Endpoint:**
   - Change the incorrect endpoint (/users/profile) to the correct one (/users/profiles).

3. **Refactor the API Call:**
   - If you are using axios or any other HTTP client, modify the URL to the correct endpoint.

### Example Code Update

Here’s an example assuming you are using axios:

\`\`\`javascript
// Before: Incorrect API endpoint
import axios from 'axios';

const fetchUserProfile = async () => {
  try {
    const response = await axios.get('/users/profile', {
      headers: {
        'Content-Type': 'application/json',
        // Add other necessary headers
      },
    });
    const data = response.data;
    return data;
  } catch (error) {
    console.error('Error fetching user profile:', error);
  }
};

// After: Corrected API endpoint
import axios from 'axios';

const fetchUserProfile = async () => {
  try {
    const response = await axios.get('/users/profiles', {
      headers: {
        'Content-Type': 'application/json',
        // Add other necessary headers
      },
    });
    const data = response.data;
    return data;
  } catch (error) {
    console.error('Error fetching user profile:', error);
  }
};\`\`\`
---
[Example 5]
[INPUT]
bug_description: Bug: Error occurs when parsing JSON data due to incorrect JSON parsing.
tech_stack: Java, Spring Boot, RESTful API
[OUTPUT]
1. **Identify the JSON Parsing Code:**
   - Find the code or function in your Java application where the JSON parsing is being handled.

2. **Update the JSON Parsing:**
   - Change the incorrect JSON parsing library (org.json) to the correct one (com.fasterxml.jackson.databind).

3. **Refactor the JSON Parsing Code:**
   - Modify the JSON parsing code to use the correct library.

### Example Code Update

Here’s an example assuming you are using com.fasterxml.jackson.databind:

\`\`\`java
// Before: Incorrect JSON parsing
import org.json.JSONObject;

public class JsonParser {
  public static void parseJson() {
    String jsonString = '{"name":"John", "age":30}';
    JSONObject jsonObject = new JSONObject(jsonString);
    String name = jsonObject.getString("name");
    int age = jsonObject.getInt("age");
  }
}

// After: Corrected JSON parsing
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

public class JsonParser {
  public static void parseJson() {
    String jsonString = '{"name":"John", "age":30}';
    ObjectMapper mapper = new ObjectMapper();
    JsonNode jsonNode = mapper.readTree(jsonString);
    String name = jsonNode.get("name").asText();
    int age = jsonNode.get("age").asInt();
  }
};\`\`\`
---
`;
